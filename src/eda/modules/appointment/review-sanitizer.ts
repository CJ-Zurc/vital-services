import { intakeSchema } from './appointment-intake.js';
// Before authorization, free text is allowlisted rather than heuristically declared anonymous.
// Unknown spans are withheld; originals remain in the private clinical record.
const words=new Set(('pain ache aching sharp dull burning pressure throbbing stabbing cramping cough fever nausea vomiting dizzy dizziness headache fatigue tired weakness breath shortness chest abdomen abdominal stomach back head neck arm leg hand foot left right upper lower mild moderate severe constant intermittent sudden gradual today yesterday days weeks months hours minutes seconds worse better movement rest walking eating breathing none no yes unknown unsure not sure with without and or in on at of the a to from is it my when since blood dry wet productive sore throat ear eye nose skin rash swelling numbness tingling diarrhea constipation').split(' '));
export function reviewText(value:unknown,knownIdentityValues:string[]|null=[]):{text:string|null;withheld:boolean}{
  if(typeof value!=='string'||!value.trim())return{text:null,withheld:false};
  const original=value.trim();
  if(knownIdentityValues===null)return{text:null,withheld:true};
  if(knownIdentityValues.some(v=>v.trim().length>1&&original.toLowerCase().includes(v.trim().toLowerCase()))||/@|https?:|\b\d{3}[- .]?\d{3}[- .]?\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/i.test(original))return{text:null,withheld:true};
  if(original.split(/[^a-z0-9]+/i).filter(Boolean).every(w=>words.has(w.toLowerCase())||/^\d{1,2}$/.test(w)))return{text:original,withheld:false};
  return{text:null,withheld:true};
}
export function reviewIntake(value:unknown,knownIdentityValues:string[]|null=[]):unknown{
  const parsed=intakeSchema.safeParse(value);
  if(parsed.success){const safe=structuredClone(parsed.data);
    for(const key of ['associatedSymptoms','additionalNotes','symptomQualityOther','aggravatingFactors','relievingFactors','specificBodyPart','symptomStartedApprox'] as const){if(typeof safe[key]==='string'&&safe[key].trim())safe[key]=reviewText(safe[key],knownIdentityValues).text??'Withheld for privacy';}
    if(safe.symptomLocation.kind!=='BODY_MAP')safe.symptomLocation.label=reviewText(safe.symptomLocation.label,knownIdentityValues).text??'Withheld for privacy';
    if(safe.radiationLocation&&safe.radiationLocation.kind!=='BODY_MAP')safe.radiationLocation.label=reviewText(safe.radiationLocation.label,knownIdentityValues).text??'Withheld for privacy';return safe;
  }

  if(typeof value==='string'){const v=reviewText(value,knownIdentityValues);return v.withheld?'Withheld for privacy':v.text;}
  if(Array.isArray(value))return value.map(v=>reviewIntake(v,knownIdentityValues));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,reviewIntake(v,knownIdentityValues)]));
  return typeof value==='number'||typeof value==='boolean'||value===null?value:null;
}
