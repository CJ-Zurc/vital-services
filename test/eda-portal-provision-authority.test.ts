import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPortalDoctorIdentityVerifier } from '../src/eda/modules/portal-integrations/portal-integrations-runtime.js';
import { portalDoctorInput } from '../src/eda/modules/portal-integrations/portal-integrations-provision.js';
import { DomainError } from '../src/eda/contracts/actor.js';

test('portal doctor identity verifier binds active Auth UUID without granting OTP or role authority',async()=>{
  const id=randomUUID(),environment={NODE_ENV:'production',VITAL_AUTH_INTERNAL_URL:'https://auth.example.test',VITAL_SERVICES_AUTH_PROFILE_KEY:'fixture-only'};
  let calls=0;
  const verify=createPortalDoctorIdentityVerifier(environment,(async(url,options)=>{
    calls++;assert.equal(String(url),'https://auth.example.test/internal/users/'+id+'/profile');
    assert.equal(options?.redirect,'error');assert.equal((options?.headers as Record<string,string>)['X-Internal-Service'],'vital-services');
    return Response.json({success:true,data:{id,is_active:true,is_deleted:false,is_banned:false,is_verified:false}});
  }) as typeof fetch);
  await verify(id);assert.equal(calls,1);
  assert.equal(portalDoctorInput.safeParse({specialty:'Cardiology',prcLicense:'TEST',availabilityType:'both',role:'admin'}).success,false);
  assert.equal(portalDoctorInput.safeParse({specialty:'Cardiology',prcLicense:'TEST',availabilityType:'both'}).success,true);
});

test('portal doctor identity verifier rejects substitution inactive identities and insecure production configuration',async()=>{
  const id=randomUUID(),environment={NODE_ENV:'production',VITAL_AUTH_INTERNAL_URL:'https://auth.example.test',VITAL_SERVICES_AUTH_PROFILE_KEY:'fixture-only'};
  for(const data of[{id:randomUUID(),is_active:true,is_deleted:false,is_banned:false},
    {id,is_active:false,is_deleted:false,is_banned:false},{id,is_active:true,is_deleted:true,is_banned:false},
    {id,is_active:true,is_deleted:false,is_banned:true},{id,is_active:true}]){
    await assert.rejects(createPortalDoctorIdentityVerifier(environment,(async()=>Response.json({success:true,data})) as typeof fetch)(id),
      error=>error instanceof DomainError&&error.status===503);
  }
  let called=false;
  await assert.rejects(createPortalDoctorIdentityVerifier({...environment,VITAL_AUTH_INTERNAL_URL:'http://auth.example.test'},
    (async()=>{called=true;throw new Error();}) as typeof fetch)(id),error=>error instanceof DomainError&&error.code==='PORTAL_AUTH_CONFIGURATION_REQUIRED');
  assert.equal(called,false);
});
