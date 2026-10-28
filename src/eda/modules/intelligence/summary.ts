import type { IntakePayload,Concept } from './contracts.js';
export function intakeBrief(input:IntakePayload,concepts:Concept[]=[]):string{
  const x=input.opqrst;
  const lines=['Patient-reported intake; no diagnosis inferred.',
    `Main symptom: ${input.primarySymptom.name}.`,
    input.chiefComplaint?`Chief complaint: ${input.chiefComplaint}`:'Chief complaint: not provided.',
    `Onset: ${x.symptomStartedAt||x.symptomStartedApprox||'not provided'}; ${x.onsetType.toLowerCase()}.`,
    `Quality: ${x.symptomQuality.map(v=>v==='Other'?x.symptomQualityOther:v).filter(Boolean).join(', ')}.`,
    `Location: ${x.symptomLocation.label}${x.specificBodyPart?`; ${x.specificBodyPart}`:''}.`,
    `Radiation: ${x.radiates==='YES'?x.radiationLocation?.label:x.radiates==='NO'?'patient reports none':'unknown'}.`,
    `Reported severity: ${x.severity}/10. Timing: ${x.timingPattern.toLowerCase()}; progression: ${x.progression.toLowerCase()}.`,
    ...(x.episodeDurationValue?[`Episode duration: ${x.episodeDurationValue} ${x.episodeDurationUnit?.toLowerCase()}.`]:[]),
    `Aggravating factors: ${x.aggravatingFactors||'not provided'}.`, `Relieving factors: ${x.relievingFactors||'not provided'}.`,
    `Associated symptoms (original answer): ${x.associatedSymptoms||'not provided'}.`,
    ...concepts.filter(c=>c.assertion==='present').map(c=>`Reported symptom: ${c.name}.`),
    ...concepts.filter(c=>c.assertion!=='present').map(c=>`${c.name}: ${c.assertion.replace('_',' ')}.`),
    ...(x.additionalNotes?[`Additional notes: ${x.additionalNotes}`]:[]),
    'Physical examination and measured vital signs are not established by this form.'];
  return lines.join('\n');
}
