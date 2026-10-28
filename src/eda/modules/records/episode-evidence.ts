// Historical evidence is limited to this case. Unscoped longitudinal fields
// (allergies, family/social history, current medication lists, etc.) are omitted.
export function episodeEvidence(value:unknown,caseId:string|null):Record<string,unknown>{
 if(!caseId||!value||typeof value!=='object'||Array.isArray(value))return{};
 const source=value as Record<string,unknown>,result:Record<string,unknown>={};
 for(const key of ['encounters','clinical_notes','case_detail_history','lab_imaging_results','diagnostic_orders','case_transactions','room_assignments','vital_signs']){
  const rows=source[key];if(Array.isArray(rows))result[key]=rows.filter(row=>row&&typeof row==='object'&&!Array.isArray(row)&&((row as Record<string,unknown>).case_id===caseId||(row as Record<string,unknown>).caseId===caseId));
 }
 result.record_scope='historical_care_episode';return result;
}
