import { intakeSchema } from './appointment-intake.js';
// Redact known patient names without suppressing clinical language or messages.
export function reviewText(value:unknown,knownIdentityValues:string[]|null=[]):{text:string|null;withheld:boolean}{
  if(typeof value!=='string'||!value.trim())return{text:null,withheld:false};
  if(knownIdentityValues===null)return{text:null,withheld:true};
  let text=value.trim();
  const names=[...new Set(knownIdentityValues.flatMap(name=>[name,...name.split(/\s+/u)]).map(name=>name.trim()).filter(name=>name.length>1))].sort((a,b)=>b.length-a.length);
  for(const name of names){
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    text=text.replace(new RegExp('(^|[^\\p{L}\\p{N}])'+escaped+'(?=$|[^\\p{L}\\p{N}])','giu'),(_,prefix:string)=>prefix+'[Patient]');
  }
  return{text,withheld:text!==value.trim()};
}
export function reviewIntake(value:unknown,knownIdentityValues:string[]|null=[]):unknown{
  const parsed=intakeSchema.safeParse(value);
  if(parsed.success){const safe=structuredClone(parsed.data);
    for(const key of ['associatedSymptoms','additionalNotes','symptomQualityOther','aggravatingFactors','relievingFactors','specificBodyPart','symptomStartedApprox'] as const){if(typeof safe[key]==='string'&&safe[key].trim())safe[key]=reviewText(safe[key],knownIdentityValues).text??'Withheld for privacy';}
    if(safe.symptomLocation.kind!=='BODY_MAP')safe.symptomLocation.label=reviewText(safe.symptomLocation.label,knownIdentityValues).text??'Withheld for privacy';
    if(safe.radiationLocation&&safe.radiationLocation.kind!=='BODY_MAP')safe.radiationLocation.label=reviewText(safe.radiationLocation.label,knownIdentityValues).text??'Withheld for privacy';return safe;
  }

  if(typeof value==='string'){const v=reviewText(value,knownIdentityValues);return v.text;}
  if(Array.isArray(value))return value.map(v=>reviewIntake(v,knownIdentityValues));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,reviewIntake(v,knownIdentityValues)]));
  return typeof value==='number'||typeof value==='boolean'||value===null?value:null;
}
