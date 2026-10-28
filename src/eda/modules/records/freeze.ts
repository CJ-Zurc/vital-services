import type { PoolClient } from "pg";
import type { AppointmentRow } from "../appointment/appointment-contracts.js";
import { protectPayload,unprotectPayload,type RecordsKeyring } from "./protection.js";
import { recordsDenied } from "./authorization.js";
import { publicDocument } from './document-view.js';

export async function freezeLocalEvidence(tx:PoolClient,keyring:RecordsKeyring,row:AppointmentRow,snapshotId:string,cutoff:Date) {
  const existing=(await tx.query('SELECT "appointmentId" FROM records_episode_freezes WHERE "appointmentId"=$1',[row.id])).rows[0];
  if(existing)return;
  const documents=(await tx.query<{id:string;assetId:string;kind:string;issuedAt:Date;protectedPayload:unknown}>(`SELECT id,"assetId",kind,"issuedAt","protectedPayload" FROM records_documents WHERE "patientId"=$1 AND "appointmentId"=$3 AND "issuedAt"<=$2 ORDER BY "issuedAt",id LIMIT 257`,[row.patientId,cutoff,row.id])).rows;
  const files=(await tx.query<{id:string;createdAt:Date;protectedPayload:unknown}>(`SELECT id,"createdAt","protectedPayload" FROM records_file_assets WHERE "patientId"=$1 AND "appointmentId"=$3 AND kind='upload' AND state='ready' AND "createdAt"<=$2 ORDER BY "createdAt",id LIMIT 257`,[row.patientId,cutoff,row.id])).rows;
  if(documents.length>256||files.length>256)recordsDenied(413,'RECORDS_EVIDENCE_COLLECTION_LIMIT');
  const payload={documents:documents.map(d=>({id:d.id,assetId:d.assetId,kind:d.kind,issuedAt:d.issuedAt.toISOString(),...publicDocument(unprotectPayload<Record<string,unknown>>(keyring,{patientId:row.patientId,resourceId:d.id,schema:'document.v1'},d.protectedPayload))})),
    files:files.map(f=>({id:f.id,assetId:f.id,createdAt:f.createdAt.toISOString(),...unprotectPayload<Record<string,unknown>>(keyring,{patientId:row.patientId,resourceId:f.id,schema:'file.v1'},f.protectedPayload)})),documentCutoffAt:cutoff.toISOString()};
  await tx.query(`INSERT INTO records_episode_freezes ("appointmentId","snapshotId","patientId","protectedPayload","cutoffAt","createdAt") VALUES($1,$2::uuid,$3,$4::jsonb,$5,NOW())`,[row.id,snapshotId,row.patientId,JSON.stringify(protectPayload(keyring,{patientId:row.patientId,resourceId:row.id,schema:'freeze.v1'},payload)),cutoff]);
  for(const assetId of new Set([...documents.map(d=>d.assetId),...files.map(f=>f.id)]))await tx.query('INSERT INTO records_snapshot_assets ("snapshotId","assetId") VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING',[snapshotId,assetId]);
}
