export function reportingBucket(date:string,interval:"daily"|"weekly"|"monthly",from:string){
 if(interval==="daily")return date;
 if(interval==="monthly")return date.slice(0,7)+"-01"<from?from:date.slice(0,7)+"-01";
 const day=new Date(date+"T00:00:00Z");day.setUTCDate(day.getUTCDate()-(day.getUTCDay()+6)%7);
 const start=day.toISOString().slice(0,10);return start<from?from:start;
}
