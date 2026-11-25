import type {Pool} from "pg";
import type {Actor} from "../../contracts/actor.js";
import {DomainError} from "../../contracts/actor.js";
import {completionRole,completionUnavailable} from "../../contracts/completion.js";
import {reportRange,reportBounds,reportBucketSql,type ReportRange,type CollectionsReport} from "../../contracts/admin-reporting.js";
import {reportingBucket} from "../intelligence/reporting-buckets.js";
import type {CompletionPaymentAuthority} from "./payment-completion.js";
export function safeCentavos(value:unknown){const n=BigInt(String(value));if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new DomainError(503,"REPORT_AMOUNT_INVALID","Financial aggregate is unavailable.");return Number(n);}
export function createCollectionsRead(pool:Pool,authority?:CompletionPaymentAuthority){
 return async(actor:Actor,raw:ReportRange):Promise<CollectionsReport>=>{
  completionRole(actor,"admin","completion.admin.collections");if(!authority)completionUnavailable("PAYMENT_AUTHORITY");await authority.admin(actor);
  const range=reportRange(raw),bounds=reportBounds(range);
  // Aggregate immutable provider payment IDs and refund IDs rather than webhook rows.
  const sql=`WITH collected AS (
    SELECT DISTINCT ON ("paymongoPaymentId") "paymongoPaymentId","amountCentavos","paidAt"
    FROM payments WHERE "paymentProvider"='paymongo' AND "providerMode"='sandbox' AND currency='PHP'
     AND "paymongoPaymentId" IS NOT NULL AND "paidAt" IS NOT NULL AND "verifiedAt" IS NOT NULL AND NOT "reviewRequired"
    ORDER BY "paymongoPaymentId",id
   ), refunded AS (
    SELECT DISTINCT ON ("refundId") "refundId","amountCentavos","refundedAt"
    FROM payments WHERE "paymentProvider"='paymongo' AND "providerMode"='sandbox' AND currency='PHP'
     AND "refundId" IS NOT NULL AND status='refunded' AND "refundedAt" IS NOT NULL AND NOT "reviewRequired"
     AND "refundReason" IS DISTINCT FROM 'TRACE external refund confirmed'
    ORDER BY "refundId",id
   ), events AS (
    SELECT ("paidAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')::date AS date,"amountCentavos"::numeric AS collected,0::numeric AS refunded FROM collected WHERE "paidAt">=$1 AND "paidAt"<$2
    UNION ALL
    SELECT ("refundedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')::date,0::numeric,"amountCentavos"::numeric FROM refunded WHERE "refundedAt">=$1 AND "refundedAt"<$2
   ) SELECT GREATEST(${reportBucketSql("date",range.interval)},$3::date)::text AS date,SUM(collected)::text AS collected,SUM(refunded)::text AS refunded FROM events GROUP BY 1 ORDER BY 1`;
  const rows=(await pool.query(sql,[...bounds,range.from])).rows;await authority.admin(actor);
  const buckets=new Map<string,{date:string;collectedCentavos:number;refundedCentavos:number;netCentavos:number}>();
  for(let d=Date.parse(range.from+"T00:00:00Z");d<=Date.parse(range.to+"T00:00:00Z");d+=86400000){const date=reportingBucket(new Date(d).toISOString().slice(0,10),range.interval,range.from);buckets.set(date,{date,collectedCentavos:0,refundedCentavos:0,netCentavos:0});}
  for(const row of rows){const collectedCentavos=safeCentavos(row.collected),refundedCentavos=safeCentavos(row.refunded);buckets.set(row.date,{date:row.date,collectedCentavos,refundedCentavos,netCentavos:collectedCentavos-refundedCentavos});}
  const series=[...buckets.values()],collectedCentavos=safeCentavos(series.reduce((n,r)=>n+BigInt(r.collectedCentavos),0n)),refundedCentavos=safeCentavos(series.reduce((n,r)=>n+BigInt(r.refundedCentavos),0n));
  return{range,currency:"PHP",providerMode:"sandbox",series,totals:{collectedCentavos,refundedCentavos,netCentavos:collectedCentavos-refundedCentavos}};
 };
}
