// Existing owner tests model an explicitly unlocked episode. Dedicated access
// tests exercise issuance, masking and denial instead of assuming approval grants it.
process.env.VITAL_APPOINTMENT_ACCESS_KEYS=JSON.stringify({1:Buffer.alloc(32,17).toString('base64')});
process.env.VITAL_APPOINTMENT_ACCESS_ACTIVE_KEY_VERSION='1';
process.env.VITAL_APPOINTMENT_ACCESS_DIGEST_KEY=Buffer.alloc(32,19).toString('base64');
export function accessFixtureSql(sql:string,args:unknown[],row?:{id?:string;patientId?:string;doctorId?:string}){
 if(sql.startsWith('SELECT summary FROM appointment_intake_briefs'))return{rows:[],rowCount:0};
 if(sql.startsWith('SELECT * FROM appointment_access'))return{rows:[{appointmentId:args[0],reference:'7K4M9Q2R',patientId:row?.patientId,doctorId:row?.doctorId,generation:1,attempts:0,digest:null,ciphertext:null,grantedAt:new Date('2026-01-01'),grantUntil:new Date('2099-01-01'),revokedAt:null,consumedAt:new Date('2026-01-01'),ageYears:null,sex:null}],rowCount:1};
 if(sql.includes('appointment_references')||sql.startsWith('UPDATE appointment_access')||sql.startsWith('INSERT INTO appointment_access')||sql.startsWith('INSERT INTO appointment_intake_briefs'))return{rows:[{reference:'7K4M9Q2R'}],rowCount:1};
 if(sql.startsWith('SELECT accepted FROM consent_records'))return{rows:[{accepted:true}],rowCount:1};
 if(sql.startsWith('SELECT opqrst FROM pre_consultations'))return{rows:[],rowCount:0};
 return null;
}
