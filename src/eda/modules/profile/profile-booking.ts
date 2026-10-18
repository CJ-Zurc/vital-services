import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Actor } from "../../contracts/actor.js";
import { DomainError } from "../../contracts/actor.js";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";
import { requestHash } from "../../infrastructure/security.js";
import { emergencyContactSchema } from "../appointment/appointment-intake.js";

// Profile-owned local interface: participate in the caller's Core transaction.
export async function saveBookingContact(tx:PoolClient,actor:Actor,patientId:string,input:unknown){
  const contact=emergencyContactSchema.parse(input);
  const patient=(await tx.query('SELECT p.*,u.version,u.role FROM vital_patients p JOIN vital_users u ON u.id=p."userId" AND u."authId"=p."authId" WHERE p."userId"=$1 AND p."authId"=$2 FOR UPDATE OF p,u',[patientId,actor.authId])).rows[0];
  if(!patient||actor.role!=="patient")throw new DomainError(403,"PROFILE_BOOKING_CONTACT_DENIED","Patient contact is unavailable.");
  if(patient.emergency_contact_name===contact.fullName&&patient.emergency_contact_relationship===contact.relationship&&patient.emergency_contact_phone===contact.phoneNumber)return;
  await tx.query('UPDATE vital_patients SET emergency_contact_name=$2,emergency_contact_relationship=$3,emergency_contact_phone=$4 WHERE "userId"=$1',[patientId,contact.fullName,contact.relationship,contact.phoneNumber]);
  const changed=await tx.query('UPDATE vital_users SET version=version+1,"updatedAt"=NOW() WHERE id=$1 RETURNING version',[patientId]);const version=changed.rows[0].version;
  const source=await appendSqlOutbox(tx,{producer:"profile",eventType:"vital.profile.changed",aggregateId:patientId,aggregateVersion:version,correlationId:actor.correlationId,
    data:{authId:actor.authId,role:patient.role,operation:"profile_updated",actorAuthId:actor.authId}});
  await appendSqlOutbox(tx,{producer:"profile",eventType:"vital.audit.requested",aggregateId:patientId,aggregateVersion:version,correlationId:actor.correlationId,causationId:source.eventId,
    data:{auditType:"vital.profile.updated",actorAuthId:actor.authId,resourceId:patientId,resourceType:"profile"}});
  const id=randomUUID(),requestId=randomUUID();const hash=requestHash("POST","/internal/users/"+actor.authId+"/stale",{});
  await tx.query(`INSERT INTO profile_sync_intents (id,"profileId","authId","sourceVersion",destination,"requestId","requestHash",payload,"createdAt") VALUES($1,$2,$3,$4,'auth-stale',$5,$6,'{}'::jsonb,NOW())`,[id,patientId,actor.authId,version,requestId,hash]);
  await appendSqlOutbox(tx,{producer:"profile",eventType:"vital.profile.sync.requested",aggregateId:patientId,aggregateVersion:version,correlationId:actor.correlationId,causationId:source.eventId,
    data:{intentId:id,authId:actor.authId,destination:"auth-stale"}});
}
