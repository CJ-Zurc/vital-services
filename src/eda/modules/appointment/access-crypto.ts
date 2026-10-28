import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { intakeCrypto } from '../intelligence/crypto.js';

const alphabet='23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function patientReference(){return Array.from({length:8},()=>alphabet[randomInt(alphabet.length)]).join('');}
export function displayReference(value:string){return `Patient #${value.slice(0,4)}-${value.slice(4)}`;}
export function appointmentPayloadCrypto(env:NodeJS.ProcessEnv=process.env){return intakeCrypto({VITAL_AI_ENCRYPTION_KEYS:env.VITAL_APPOINTMENT_ACCESS_KEYS,VITAL_AI_ACTIVE_KEY_VERSION:env.VITAL_APPOINTMENT_ACCESS_ACTIVE_KEY_VERSION});}
export function accessCrypto(env:NodeJS.ProcessEnv=process.env){
  const cipher=appointmentPayloadCrypto(env);
  function digest(code:string,binding:string){
    const key=Buffer.from(env.VITAL_APPOINTMENT_ACCESS_DIGEST_KEY??'','base64');
    if(key.length!==32)throw Error('APPOINTMENT_ACCESS_DIGEST_KEY_REQUIRED');
    return createHmac('sha256',key).update(JSON.stringify([binding,code])).digest('hex');
  }
  return{assertConfigured(){cipher.assertConfigured();digest('000000','configuration');},
    issue(binding:string){const code=String(randomInt(1_000_000)).padStart(6,'0');return{digest:digest(code,binding),ciphertext:cipher.encrypt(code,binding)};},
    verify(code:string,binding:string,expected:string){if(!/^\d{6}$/.test(code)||! /^[a-f0-9]{64}$/.test(expected))return false;return timingSafeEqual(Buffer.from(digest(code,binding),'hex'),Buffer.from(expected,'hex'));},
    retrieve(ciphertext:unknown,binding:string){return cipher.decrypt(ciphertext,binding) as string;}};
}
