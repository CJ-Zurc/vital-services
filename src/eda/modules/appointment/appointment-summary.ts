import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { intakePayloadSchema,type Concept } from '../intelligence/contracts.js';
import { intakeBrief } from '../intelligence/summary.js';
import { appointmentPayloadCrypto } from './access-crypto.js';
import { reviewText,reviewIntake } from './review-sanitizer.js';

export function restrictedBrief(payload:ReturnType<typeof intakePayloadSchema.parse>|null,concepts:Concept[]=[],knownIdentities:string[]|null=[]){
 if(!payload)return 'Patient-reported intake; no diagnosis inferred. Structured OPQRST is missing or uses an unsupported legacy form. Some information is withheld for privacy. Doctor review is required.';
 const safe=structuredClone(payload);safe.opqrst=reviewIntake(safe.opqrst,knownIdentities) as typeof safe.opqrst;
 safe.chiefComplaint=reviewText(safe.chiefComplaint,knownIdentities).text??(safe.chiefComplaint?'Withheld for privacy':null);
 safe.primarySymptom.name=concepts.find(c=>c.assertion==='present')?.name??'Not specified';
 return intakeBrief(safe,concepts);
}

export async function saveOperationalBrief(db:Pick<PoolClient,'query'>,appointmentId:string,chiefComplaint:string|null,opqrst:unknown,concepts:Concept[]=[],intakeVersion=1){
 const parsed=intakePayloadSchema.safeParse({chiefComplaint,opqrst,primarySymptom:{id:null,name:concepts.find(c=>c.assertion==='present')?.name??'Not specified'}}),payload=parsed.success?parsed.data:null;
 const brief=payload?intakeBrief(payload,concepts):'Patient-reported intake; no diagnosis inferred. Structured OPQRST is missing or from an unsupported legacy form. Chief complaint: '+(chiefComplaint??'not provided')+'. Doctor review is required.',sourceHash=createHash('sha256').update(JSON.stringify({chiefComplaint,opqrst,concepts,intakeVersion})).digest('hex');
 const summary=appointmentPayloadCrypto().encrypt({brief,concepts,payload},'appointment-brief:'+appointmentId);
 await db.query(`INSERT INTO appointment_intake_briefs("appointmentId","intakeVersion","sourceHash",summary) VALUES($1,$2,$3,$4::jsonb)
 ON CONFLICT("appointmentId") DO UPDATE SET "intakeVersion"=EXCLUDED."intakeVersion","sourceHash"=EXCLUDED."sourceHash",summary=EXCLUDED.summary,"approvedText"=NULL,"approvedHash"=NULL,"approvedBy"=NULL,"approvedAt"=NULL`,[appointmentId,intakeVersion,sourceHash,JSON.stringify(summary)]);
}

export async function copyOperationalBrief(db:Pick<PoolClient,'query'>,sourceId:string,targetId:string){
 const source=(await db.query('SELECT summary,"sourceHash","intakeVersion" FROM appointment_intake_briefs WHERE "appointmentId"=$1',[sourceId])).rows[0];
 if(!source)return;
 const crypto=appointmentPayloadCrypto(),content=crypto.decrypt(source.summary,'appointment-brief:'+sourceId);
 await db.query('INSERT INTO appointment_intake_briefs("appointmentId","intakeVersion","sourceHash",summary) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[targetId,source.intakeVersion,source.sourceHash,JSON.stringify(crypto.encrypt(content,'appointment-brief:'+targetId))]);
}
