import test from "node:test";
import assert from "node:assert/strict";
import {patternSnapshot,dashboard} from "../src/eda/modules/intelligence/module.js";
import {reportingBucket} from "../src/eda/modules/intelligence/reporting-buckets.js";
import type {Pool} from "pg";
test("buckets use Monday weeks and clip partial weeks/months",()=>{
 assert.equal(reportingBucket("2026-11-25","weekly","2026-11-01"),"2026-11-23");
 assert.equal(reportingBucket("2026-11-01","weekly","2026-11-01"),"2026-11-01");
 assert.equal(reportingBucket("2026-11-25","monthly","2026-11-20"),"2026-11-20");
});
test("patterns preserve ranking, cohort boundaries and complementary suppression",()=>{
 const result=patternSnapshot({id:"v",createdAt:"2026-11-25T00:00:00Z",payload:{cohorts:[{cohort:"adult",count:18,noise:3,status:"completed"}],clusters:[{id:"adult-0",count:5,suggestedLabel:"Fever"},{id:"adult-1",count:10,suggestedLabel:"Headache"}]}});
 assert.equal(result.cohorts[0].count,null);assert.equal(result.cohorts[0].noise,null);
 assert.equal(result.cohorts[0].groups[0].label,"Headache");
 assert.equal(result.cohorts[0].groups[0].percentage,10/15);
 assert.doesNotMatch(JSON.stringify(result),/reviewed|members|reviewer/);
});
test("weekly suppression is applied after aggregation while zero remains zero",async()=>{
 const pool={query:async()=>({rows:Array.from({length:6},(_,i)=>({date:i<3?"2026-11-23":"2026-11-24",status:"completed",features:{symptoms:[]}}))})} as unknown as Pool;
 const result=await dashboard(pool,{from:"2026-11-23",to:"2026-11-30",interval:"weekly"});
 assert.equal(result.daily[0].submissions,null);assert.equal(result.series[0].submissions,6);assert.equal(result.series[1].submissions,0);assert.equal(result.clusters,null);
});
