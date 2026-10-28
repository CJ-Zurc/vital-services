import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { z } from 'zod';
const envelope=z.object({keyVersion:z.number().int().positive(),nonce:z.string(),tag:z.string(),ciphertext:z.string()}).strict();
export function intakeCrypto(environment:NodeJS.ProcessEnv=process.env){
  function keys(){
    const source=z.record(z.string().regex(/^[1-9][0-9]*$/),z.string()).parse(JSON.parse(environment.VITAL_AI_ENCRYPTION_KEYS??'{}'));
    const mapped=new Map(Object.entries(source).map(([v,k])=>{const b=Buffer.from(k,'base64');if(b.length!==32||b.toString('base64')!==k)throw Error('AI_KEY_INVALID');return[Number(v),b] as const;}));
    const active=Number(environment.VITAL_AI_ACTIVE_KEY_VERSION);if(!mapped.has(active))throw Error('AI_ACTIVE_KEY_REQUIRED');return{mapped,active};
  }
  return{
    assertConfigured(){keys();},
    encrypt(value:unknown,binding:string){const{mapped,active}=keys(),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',mapped.get(active)!,nonce);cipher.setAAD(Buffer.from(binding));
      const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]).toString('base64');
      return{keyVersion:active,nonce:nonce.toString('base64'),ciphertext,tag:cipher.getAuthTag().toString('base64')};
    },
    decrypt(value:unknown,binding:string){const v=envelope.parse(value),key=keys().mapped.get(v.keyVersion);if(!key)throw Error('AI_KEY_UNAVAILABLE');const nonce=Buffer.from(v.nonce,'base64'),tag=Buffer.from(v.tag,'base64');if(nonce.length!==12||tag.length!==16)throw Error('AI_CIPHER_INVALID');
      const d=createDecipheriv('aes-256-gcm',key,nonce);d.setAAD(Buffer.from(binding));d.setAuthTag(tag);return JSON.parse(Buffer.concat([d.update(Buffer.from(v.ciphertext,'base64')),d.final()]).toString('utf8')) as unknown;}
  };
}
