import {z} from "zod";
import {DomainError} from "./actor.js";
export const reportRangeSchema=z.object({from:z.iso.date(),to:z.iso.date(),interval:z.enum(["daily","weekly","monthly"]).default("weekly")}).strict();
export type ReportRange=z.infer<typeof reportRangeSchema>;
export function reportRange(raw:unknown):ReportRange{
 const value=reportRangeSchema.parse(raw);
 if(value.from>value.to||Date.parse(value.to)-Date.parse(value.from)>365*86400000)throw new DomainError(400,"REPORT_RANGE_INVALID","Choose a valid reporting period of at most 366 days.");
 return value;
}
export function reportBounds(range:ReportRange){return [new Date(range.from+"T00:00:00+08:00").toISOString().slice(0,-1),new Date(Date.parse(range.to+"T00:00:00+08:00")+86400000).toISOString().slice(0,-1)];}
export function reportBucketSql(column:string,interval:ReportRange["interval"]){return interval==="daily"?column:interval==="weekly"?"date_trunc('week',"+column+")::date":"date_trunc('month',"+column+")::date";}
export interface CollectionsReport{range:ReportRange;currency:"PHP";providerMode:"sandbox";series:{date:string;collectedCentavos:number;refundedCentavos:number;netCentavos:number}[];totals:{collectedCentavos:number;refundedCentavos:number;netCentavos:number}}
export interface SatisfactionReport{range:ReportRange;count:number;overall:number|null;criteria:{friendlinessAttitude:number|null;professionalism:number|null;explanation:number|null;careServices:number|null}}
export interface SpecialtyReport{range:ReportRange;total:number;items:{specialty:string;count:number}[]}
