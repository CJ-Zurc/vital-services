import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type EncryptedMessage = { id: string; ciphertext: string; nonce: string; authTag: string; keyVersion: number };
export function createMessageCrypto(environment: NodeJS.ProcessEnv = process.env) {
  function decode(value: string, length?: number) {
    if (typeof value !== 'string' || value.length > 11000) throw new Error('MESSAGE_CIPHER_INVALID');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value || length !== undefined && bytes.length !== length) throw new Error('MESSAGE_CIPHER_INVALID');
    return bytes;
  }
  function keySet() {
    let configured: Record<string, string>;
    try { configured = JSON.parse(environment.MESSAGE_ENCRYPTION_KEYS ?? '{}'); }
    catch { throw new Error('MESSAGE_KEYS_INVALID'); }
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('MESSAGE_KEYS_INVALID');
    const keys = new Map<number, Buffer>();
    for (const [version, value] of Object.entries(configured)) {
      if (!/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version)) || Number(version) > 2147483647 || typeof value !== 'string') throw new Error('MESSAGE_KEYS_INVALID');
      const key = Buffer.from(value, 'base64');
      if (key.length !== 32 || key.toString('base64') !== value) throw new Error('MESSAGE_KEYS_INVALID');
      keys.set(Number(version), key);
    }
    const active = Number(environment.MESSAGE_ACTIVE_KEY_VERSION);
    if (!Number.isSafeInteger(active) || !keys.has(active)) throw new Error('MESSAGE_ACTIVE_KEY_REQUIRED');
    return { keys, active };
  }
  return {
    assertConfigured() { keySet(); },
    encrypt(content: string, appointmentId: string, messageId: string) {
      const { keys, active } = keySet();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keys.get(active)!, nonce);
      cipher.setAAD(Buffer.from(`${appointmentId}:${messageId}`));
      return { ciphertext: Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]).toString('base64'),
        nonce: nonce.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), keyVersion: active };
    },
    decrypt(message: EncryptedMessage, appointmentId: string) {
      const key = keySet().keys.get(message.keyVersion);
      if (!key) throw new Error('MESSAGE_DECRYPTION_KEY_UNAVAILABLE');
      const nonce = decode(message.nonce, 12), tag = decode(message.authTag, 16), ciphertext = decode(message.ciphertext);
      if (!ciphertext.length || ciphertext.length > 8000) throw new Error('MESSAGE_CIPHER_INVALID');
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(`${appointmentId}:${message.id}`));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}
