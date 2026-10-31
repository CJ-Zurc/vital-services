import assert from "node:assert/strict";
import { randomUUID,generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer,request as httpsRequest } from "node:https";
import type { TestContext } from "node:test";
import jwt from "jsonwebtoken";
import { PrismaClient } from "../../src/eda/generated/core/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { createEdaApp } from "../../src/eda/http/app.js";
import { createAppointmentModule,readAppointment } from "../../src/eda/modules/appointment/appointment.js";
import { createAppointmentSaga } from "../../src/eda/modules/appointment/appointment-saga.js";
import { createRescheduleAuthority } from "../../src/eda/modules/appointment/appointment-saga-authority.js";
import { resumeAppointmentSaga } from "../../src/eda/modules/appointment/appointment-review.js";
import { createPaymentAssociation } from "../../src/eda/modules/payment/payment-association.js";
import { createPaymentModule } from "../../src/eda/modules/payment/payment.js";
import { consumeAppointmentPayment } from "../../src/eda/workers/appointment-payment.js";
import { envelopeFromRow,type OutboxRow } from "../../src/eda/infrastructure/outbox.js";
import { publishConfirmed } from "../../src/eda/infrastructure/broker.js";
import { requestHash } from "../../src/eda/infrastructure/security.js";
import type { Actor } from "../../src/eda/contracts/actor.js";
import type { AppointmentOwners,ParticipantReceipt } from "../../src/eda/modules/appointment/appointment-contracts.js";
import { fixture,type Context } from "./payment-live.js";

const command=()=>({operationId:randomUUID(),requestHash:"a".repeat(64)});
function day(days:number){return new Date(Date.now()+days*86400000).toISOString().slice(0,10);}
export async function appointmentLiveScenarios(t:TestContext,context:Context){
  await t.test("EDA Appointment real PostgreSQL serializes overlapping calendar writers",()=>fixture(context,async f=>{
    await context.core.query(`UPDATE vital_doctors SET specialty='Verified fixture department',"availabilityType"='virtual' WHERE "userId"=$1`,[f.doctorId]);
    const module=createAppointmentModule(context.core);
    const actor:Actor={...f.actor,authId:f.doctorAuthId,role:'doctor',resource:f.doctorAuthId,scopes:['appointments.schedule.write']};
    const outcomes=await Promise.allSettled([module.createSchedule(actor,command(),{slotDate:day(5),startTime:'10:00',endTime:'11:00',consultationType:'virtual'}),
      module.createSchedule(actor,command(),{slotDate:day(5),startTime:'10:30',endTime:'11:30',consultationType:'virtual'})]);
    assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);
    assert.equal((await context.core.query('SELECT id FROM schedules WHERE "doctorId"=$1',[f.doctorId])).rowCount,1);
  }));
  await t.test("EDA Appointment real inbox confirms once and reschedule recovers forward after participant failure",()=>fixture(context,async f=>{
    const authority=createRescheduleAuthority(context.core);
    const payment=createPaymentModule({store:f.store,billing:f.billing,provider:f.provider,enabled:true,appOrigin:'https://vital.test',
      association:createPaymentAssociation(context.integrations,authority)});
    // These are explicit test-only owner fixtures, never runtime substitutes.
    const receipts=new Map<string,ParticipantReceipt>();let failFinalize=true;
    const video={validate:async()=>{},prepareWorkflow:async()=>{throw new Error('UNUSED_TEST_WORKFLOW');},finalizeWorkflow:async()=>{throw new Error('UNUSED_TEST_WORKFLOW');},participant:{
      async prepare(id:string){const intent=await authority(id);const old=receipts.get(id);if(old)return old;
        const receipt:ParticipantReceipt={...intent,participant:'video',freezeToken:randomUUID(),resourceId:null,resourceVersion:null};receipts.set(id,receipt);return receipt;},
      async abort(id:string){assert.equal((await authority(id)).pivotCommittedAt,null);},
      async finalize(id:string,token:string){assert.ok((await authority(id)).pivotCommittedAt);assert.equal(receipts.get(id)?.freezeToken,token);
        if(failFinalize){failFinalize=false;throw new Error('TEST_FINALIZATION_CRASH');}}
    }};
    const owners:AppointmentOwners={video,records:{apply:async()=>{}},financial:{verifyPaid:payment.verifyAppointmentPaid},
      payment:{prepare:payment.prepareReassociation,abort:payment.abortReassociation,finalize:payment.finalizeReassociation}};
    const module=createAppointmentModule(context.core,owners),saga=createAppointmentSaga(context.core,owners);
    await payment.checkout(f.actor,f.appointmentId,command());f.pay();
    await payment.reconcile({...f.actor,scopes:['payments.reconcile']},f.appointmentId,command());
    const paid=(await f.store.byAppointment(f.appointmentId))!;
    const fact=(await context.integrations.query<OutboxRow>('SELECT * FROM outbox_events WHERE "aggregateId"=$1 AND "eventType"=$2',[paid.id,'vital.payment.completed'])).rows[0]!;
    const event=envelopeFromRow(fact);await publishConfirmed(context.publisher,context.exchange,'routed',event);
    const delivery=await context.channel.get(context.queue,{noAck:false});assert.ok(delivery);
    await Promise.all([consumeAppointmentPayment(context.core,context.integrations,event,module.confirmPayment),consumeAppointmentPayment(context.core,context.integrations,event,module.confirmPayment)]);
    context.channel.ack(delivery);
    const source=await readAppointment(context.core,f.appointmentId);assert.equal(source.status,'confirmed');
    assert.equal((await context.core.query('SELECT id FROM appointment_logs WHERE "appointmentId"=$1',[source.id])).rowCount,1);
    const doctor:Actor={...f.actor,authId:f.doctorAuthId,role:'doctor',scopes:['appointments.reschedule']};
    const proposal=await module.propose(doctor,source.id,command(),{expectedVersion:source.version,slotDate:day(4),startTime:'10:00',endTime:'11:00',reason:'test-only'});
    const accept=command();const actor:Actor={...f.actor,resource:proposal.id,scopes:['appointments.accept-reschedule']};
    await saga.accept(actor,proposal.id,accept,{expectedVersion:proposal.version,expectedSourceVersion:source.version});
    const halfway=(await context.core.query('SELECT * FROM saga_operations WHERE id=$1',[accept.operationId])).rows[0];
    assert.equal(halfway.status,'finalizing');assert.ok(halfway.pivotCommittedAt);
    assert.equal((await f.store.byAppointment(proposal.id))?.providerOriginAppointmentId,source.id);
    await saga.advance(accept.operationId);await saga.advance(accept.operationId);
    assert.equal((await context.core.query('SELECT status FROM saga_operations WHERE id=$1',[accept.operationId])).rows[0].status,'completed');
    const replacement=await readAppointment(context.core,proposal.id);assert.equal(replacement.doctorRescheduleCount,1);assert.equal(replacement.status,'confirmed');
    assert.equal((await f.billing.current(replacement.id)).payable,true);
    assert.equal(f.writes(),1);
    assert.equal((await context.integrations.query('SELECT id FROM outbox_events WHERE "aggregateId"=$1 AND "eventType"=$2',[paid.id,'vital.payment.completed'])).rowCount,1);
  }));
  await t.test("EDA Appointment actual mTLS calendar hop rejects certificate audience resource and body substitution",()=>fixture(context,async f=>{
    const prisma=new PrismaClient({adapter:new PrismaPg(context.core,{disposeExternalPool:false})});
    const module=createAppointmentModule(context.core),saga=createAppointmentSaga(context.core,{});
    const keys=generateKeyPairSync('rsa',{modulusLength:2048});
    const app=createEdaApp(prisma,{issuer:'vital-web',audience:'vital-services',peerName:'vital-web',keyId:'test',
      publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString()},false,undefined,undefined,
      {module,saga,resume:(actor,id,meta,body)=>resumeAppointmentSaga(context.core,actor,id,meta,body),maintenanceTick:async()=>{}});
    const server=createServer({key:readFileSync(context.certs.apiKey),cert:readFileSync(context.certs.apiCert),ca:readFileSync(context.certs.serviceCa),requestCert:true,rejectUnauthorized:true},app);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
    await context.core.query('UPDATE vital_doctors SET specialty=$2,"availabilityType"=$3 WHERE "userId"=$1',[f.doctorId,'Cardiology','virtual']);
    const path='/internal/v1/schedules/preview';
    const input={selection:{mode:'custom',dates:[day(10)]},times:[{startTime:'09:00',endTime:'09:30'}],consultationType:'virtual',isPublished:true};
    function call(certificate:boolean,audience='vital-services',resource=f.doctorAuthId,body:unknown=input,targetPath=path){
      const operationId=randomUUID();const hash=requestHash('POST',targetPath,body);
      const actor={...f.actor,authId:f.doctorAuthId,role:'doctor',scopes:['appointments.schedule.write'],resource};
      const token=jwt.sign({actor,action:'POST '+targetPath,requestHash:hash,operationId},keys.privateKey,{algorithm:'RS256',keyid:'test',issuer:'vital-web',audience,subject:f.doctorAuthId,jwtid:randomUUID(),expiresIn:30});
      return new Promise<number>((resolve,reject)=>{const request=httpsRequest({host:'127.0.0.1',port,servername:'vital-api.test',path:targetPath,method:'POST',
        ca:readFileSync(context.certs.serviceCa),...(certificate?{cert:readFileSync(context.certs.webCert),key:readFileSync(context.certs.webKey)}:{}),
        rejectUnauthorized:true,headers:{'Content-Type':'application/json','X-Vital-Actor-Assertion':token,'Idempotency-Key':operationId}},response=>{
          response.resume();response.once('end',()=>resolve(response.statusCode??0));});request.setTimeout(5000,()=>request.destroy(new Error('TEST_TLS_TIMEOUT')));request.once('error',reject);request.end(JSON.stringify(body));});
    }
    try{await assert.rejects(call(false));assert.equal(await call(true,'wrong-audience'),401);assert.equal(await call(true,'vital-services',randomUUID()),403);
      assert.equal(await call(true,'vital-services',f.doctorAuthId,{...input,doctorId:f.doctorId}),400);assert.equal(await call(true),200);
      assert.equal(await call(true,'vital-services',f.doctorAuthId,{},'/internal/v1/date-blocks'),410);}
    finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await prisma.$disconnect();
      await context.core.query('DELETE FROM doctor_date_blocks WHERE doctor_id=$1',[f.doctorId]);}
  }));
}
