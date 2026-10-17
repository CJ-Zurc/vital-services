import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import canonicalize from "canonicalize";
import { z } from "zod";
import { DomainError } from "../../contracts/actor.js";

const envelope = z.object({ schemaVersion: z.literal(1), keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  nonce: z.string(), ciphertext: z.string(), tag: z.string() }).strict();
export type ProtectedPayload = z.infer<typeof envelope>;
export interface RecordsKeyring { activeKeyId: string; keys: Readonly<Record<string, Buffer>> }
export interface PayloadBinding { patientId: string; resourceId: string; schema: string }
function aad(binding: PayloadBinding) { return Buffer.from(JSON.stringify(["vital-records",1,binding.patientId,binding.resourceId,binding.schema]), "utf8"); }
export function recordsKeyring(input: unknown): RecordsKeyring {
  const value = z.object({ activeKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    keys: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),z.string().regex(/^[A-Za-z0-9+/]{43}=$/)) }).strict().parse(input);
  const entries = Object.entries(value.keys);
  if (!entries.length || entries.length > 8) throw new Error("RECORDS_KEYRING_INVALID");
  const keys = Object.fromEntries(entries.map(([id, encoded]) => {
    const bytes = Buffer.from(encoded,"base64");
    if (bytes.length!==32 || bytes.toString("base64")!==encoded) throw new Error("RECORDS_KEYRING_INVALID");
    return [id, bytes];
  }));
  if (!Object.hasOwn(keys,value.activeKeyId)) throw new Error("RECORDS_KEYRING_INVALID");
  return { activeKeyId:value.activeKeyId, keys };
}
export function protectPayload(keyring: RecordsKeyring, binding: PayloadBinding, payload: unknown): ProtectedPayload {
  const key = keyring.keys[keyring.activeKeyId];
  if (!key || key.length!==32) throw new DomainError(503,"RECORDS_KEY_UNAVAILABLE","Records encryption unavailable.");
  const plain = JSON.stringify(payload);
  if (!plain || Buffer.byteLength(plain)>2*1024*1024) throw new DomainError(413,"RECORDS_PAYLOAD_LIMIT","Records payload is too large.");
  const nonce = randomBytes(12), cipher=createCipheriv("aes-256-gcm",key,nonce);
  cipher.setAAD(aad(binding));
  const ciphertext=Buffer.concat([cipher.update(plain,"utf8"),cipher.final()]);
  return {schemaVersion:1,keyId:keyring.activeKeyId,nonce:nonce.toString("base64"),ciphertext:ciphertext.toString("base64"),tag:cipher.getAuthTag().toString("base64")};
}
export function unprotectPayload<T=unknown>(keyring: RecordsKeyring, binding: PayloadBinding, input: unknown): T {
  try {
    const value=envelope.parse(input);
    const key=Object.hasOwn(keyring.keys,value.keyId)?keyring.keys[value.keyId]:undefined;
    if (!key || key.length!==32) throw new Error("KEY_MISSING");
    const nonce=Buffer.from(value.nonce,"base64"),tag=Buffer.from(value.tag,"base64"),body=Buffer.from(value.ciphertext,"base64");
    if(nonce.length!==12||tag.length!==16||body.length>2*1024*1024)throw new Error("INVALID_CIPHERTEXT");
    const decipher=createDecipheriv("aes-256-gcm",key,nonce);decipher.setAAD(aad(binding));decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body),decipher.final()]).toString("utf8")) as T;
  } catch { throw new DomainError(503,"RECORDS_PAYLOAD_UNAVAILABLE","Protected Records payload unavailable."); }
}
// JCS is intentionally separate from the existing command-hash contract.
export function clinicalHash(payload: unknown) {
  let nodes=0;
  const invalidUnicode=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const valid=(value:unknown,depth:number):void=>{
    if(++nodes>50000||depth>40||typeof value==='number'&&!Number.isFinite(value)||typeof value==='string'&&invalidUnicode.test(value))
      throw new DomainError(400,'RECORDS_CANONICAL_PAYLOAD_INVALID','Invalid clinical payload.');
    if(Array.isArray(value))for(const item of value)valid(item,depth+1);
    else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){if(invalidUnicode.test(key))throw new DomainError(400,'RECORDS_CANONICAL_PAYLOAD_INVALID','Invalid clinical payload.');valid(item,depth+1);}
  };
  valid(payload,0);
  const serialized=canonicalize(payload);
  if (typeof serialized!=="string" || Buffer.byteLength(serialized)>2*1024*1024) throw new DomainError(400,"RECORDS_CANONICAL_PAYLOAD_INVALID","Invalid clinical payload.");
  return createHash("sha256").update(serialized,"utf8").digest("hex");
}
