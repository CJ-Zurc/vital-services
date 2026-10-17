import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DomainError } from "../../contracts/actor.js";

export type MeetKeyring = Readonly<{ activeKeyId: string }>;
const keyrings = new WeakMap<MeetKeyring, ReadonlyMap<string, Buffer>>();
const keyId = /^[A-Za-z0-9_-]{1,32}$/;
const maxSecretBytes = 8192;
const maxEnvelopeChars = 32 + 16 + 24 + Math.ceil(maxSecretBytes / 3) * 4 + 3;
function invalid(): never { throw new DomainError(503, "VIDEO_CRYPTO_INVALID", "Invalid Meet credential or key configuration."); }
function canonical(value: unknown, bytes?: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maxSecretBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid();
  const decoded = Buffer.from(value, "base64");
  if ((bytes !== undefined && decoded.length !== bytes) || decoded.toString("base64") !== value) invalid();
  return decoded;
}
function ownerId(owner: string) {
  if (typeof owner !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) invalid();
}
function keys(keyring: MeetKeyring) {
  const result = keyrings.get(keyring);
  if (!result) invalid();
  return result;
}

export function meetKeyring(input: { activeKeyId: string; keys: Record<string, string> }): MeetKeyring {
  if (!input || typeof input.activeKeyId !== "string" || !keyId.test(input.activeKeyId)
    || !input.keys || typeof input.keys !== "object" || Array.isArray(input.keys)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input.keys))) invalid();
  const entries = Object.entries(input.keys);
  if (entries.length < 1 || entries.length > 32) invalid();
  const result = new Map<string, Buffer>();
  for (const [version, value] of entries) {
    if (!keyId.test(version)) invalid();
    result.set(version, canonical(value, 32));
  }
  if (!result.has(input.activeKeyId)) invalid();
  const keyring = Object.freeze({ activeKeyId: input.activeKeyId });
  keyrings.set(keyring, result);
  return keyring;
}

export function encryptMeetSecret(keyring: MeetKeyring, value: string, owner: string): string {
  ownerId(owner);
  if (typeof value !== "string" || value.length < 1 || value.length > maxSecretBytes) invalid();
  const plain = Buffer.from(value, "utf8");
  if (plain.length > maxSecretBytes || plain.toString("utf8") !== value) invalid();
  const allowed = keys(keyring);
  const version = keyring.activeKeyId;
  const key = allowed.get(version);
  if (!key) invalid();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${version}:${owner}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [version, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptMeetSecret(keyring: MeetKeyring, value: string, owner: string): string {
  try {
    ownerId(owner);
    if (typeof value !== "string" || value.length > maxEnvelopeChars) invalid();
    const parts = value.split(".");
    if (parts.length !== 4) invalid();
    const [version, iv, tag, ciphertext] = parts;
    if (!version || !keyId.test(version)) invalid();
    const key = keys(keyring).get(version);
    if (!key) invalid();
    const nonce = canonical(iv, 12);
    const authTag = canonical(tag, 16);
    const encrypted = canonical(ciphertext);
    if (encrypted.length < 1 || encrypted.length > maxSecretBytes) invalid();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(`${version}:${owner}`, "utf8"));
    decipher.setAuthTag(authTag);
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([decipher.update(encrypted), decipher.final()]));
  } catch { invalid(); }
}
