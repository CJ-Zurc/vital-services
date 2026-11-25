import test from "node:test";
import assert from "node:assert/strict";
import type {Pool} from "pg";
import type {Actor} from "../src/eda/contracts/actor.js";
import {reportRange,reportBounds} from "../src/eda/contracts/admin-reporting.js";
import {createCollectionsRead,safeCentavos} from "../src/eda/modules/payment/payment-collections.js";
import {createAppointmentAdminReporting} from "../src/eda/modules/appointment/appointment-admin-reporting.js";
import {readDisputeReport,disputePageQuery} from "../src/eda/modules/appointment/dispute-reporting.js";
const range={from:"2026-11-01",to:"2026-11-30",interval:"weekly" as const};
const actor=(kind:string)=>({authId:"11111111-1111-4111-8111-111111111111",role:"admin",scopes:[kind],resource:"11111111-1111-4111-8111-111111111111",correlationId:"22222222-2222-4222-8222-222222222222"} as Actor);
test("report ranges bound inclusive Philippine days and reject reversed or excessive dates",()=>{
 assert.deepEqual(reportBounds(range),["2026-10-31T16:00:00.000","2026-11-30T16:00:00.000"]);
 assert.throws(()=>reportRange({...range,from:"2027-01-01"}));assert.throws(()=>reportRange({...range,from:"2020-01-01"}));assert.throws(()=>reportRange({...range,to:"2026-02-30"}));
 assert.throws(()=>safeCentavos("9007199254740992"));assert.throws(()=>safeCentavos("-1"));
});
test("collections use provider identifiers and event dates, preserve negative net and fill empty buckets",async()=>{
 let sql="",args:unknown[]=[];let authorized=0;
 const pool={query:async(q:string,a:unknown[])=>{sql=q;args=a;return{rows:[{date:"2026-11-01",collected:"0",refunded:"12345"},{date:"2026-11-02",collected:"10001",refunded:"0"}]};}} as unknown as Pool;
 const read=createCollectionsRead(pool,{admin:async()=>{authorized++;},patient:async()=>""}),result=await read(actor("completion.admin.collections"),range);
 assert.equal(result.totals.collectedCentavos,10001);assert.equal(result.totals.refundedCentavos,12345);assert.equal(result.totals.netCentavos,-2344);assert.equal(result.series.length,6);assert.equal(result.series.at(-1)?.collectedCentavos,0);assert.equal(authorized,2);
 assert.match(sql,/DISTINCT ON \("paymongoPaymentId"\)/);assert.match(sql,/DISTINCT ON \("refundId"\)/);assert.match(sql,/TRACE external refund confirmed/);assert.match(sql,/"verifiedAt" IS NOT NULL/);assert.match(sql,/"providerMode"='sandbox'/);assert.deepEqual(args.slice(0,2),reportBounds(range));
 await assert.rejects(()=>read({...actor("completion.admin.collections"),role:"patient"},range),{status:403});
});
test("appointment reports average valid criterion reviews and group completed visits globally",async()=>{
 const calls:string[]=[];
 const db={query:async(sql:string)=>{calls.push(sql);return{rowCount:1,rows:sql.includes('AVG(f.')?[{count:"2",overall:4.125,friendlinessAttitude:4,professionalism:4.5,explanation:4,careServices:4}]:sql.includes('COUNT(DISTINCT a.id)')?[{specialty:"Internal Medicine",count:"7"},{specialty:"Unlisted",count:"2"}]:[{}]};},release(){}};
 const owner=createAppointmentAdminReporting({connect:async()=>db} as unknown as Pool);
 const satisfaction=await owner.satisfaction(actor("completion.admin.satisfaction"),range);assert.equal(satisfaction.overall,4.125);assert.equal(satisfaction.count,2);
 const specialties=await owner.specialties(actor("completion.admin.specialties"),range);assert.equal(specialties.total,9);
 assert.ok(calls.some(sql=>sql.includes('"ratingVersion"=2')&&sql.includes("a.status='completed'")));assert.ok(calls.some(sql=>sql.includes('a."completedAt">=$1')));assert.equal(calls.filter(sql=>sql==="COMMIT").length,2);
});
test("dispute aggregates cover all outstanding items while page size and cursor remain bounded",async()=>{
 const rows=Array.from({length:26},(_,i)=>({id:"00000000-0000-4000-8000-"+String(i).padStart(12,"0"),createdAt:new Date("2026-11-01T00:00:00Z"),reason:"needs_review"}));
 const queries:string[]=[];
 const db={query:async(sql:string)=>{queries.push(sql);return{rowCount:1,rows:sql.includes('SELECT r.id')?rows:sql.includes('GROUP BY r.reason')?[{reason:"needs_review",status:"confirmed",count:80}]:sql.includes('pendingDeliveries')?[{pendingDeliveries:2,pendingResponses:3,overdueHolds:1,oldestPendingResponseAt:null}]:[{}]};},release(){}};
 const result=await readDisputeReport({connect:async()=>db} as unknown as Pool,actor("trace-disputes.reviews"),{},()=>Date.parse("2026-11-25T00:00:00Z"));
 assert.equal(result.items.length,25);assert.equal(result.total,80);assert.equal(result.counts.reasons[0].count,80);assert.ok(result.nextCursor);
 assert.equal(disputePageQuery({cursor:result.nextCursor})?.id,rows[24].id);assert.throws(()=>disputePageQuery({cursor:"invalid"}));assert.throws(()=>disputePageQuery({limit:1000}));
 assert.ok(queries.some(sql=>sql.includes('LIMIT 26')&&sql.includes('$3::uuid')&&sql.includes('$2::timestamptz')));assert.ok(queries.some(sql=>sql.includes('GROUP BY r.reason')&&!sql.includes('LIMIT')));
});
