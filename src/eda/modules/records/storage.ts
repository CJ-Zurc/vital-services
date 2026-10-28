import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ArtifactError, MAX_UPLOAD_BYTES, sha256, type RecordsMime } from "./upload-validation.js";

export type RecordsStorageConfig = {
  endpoint: string; publicEndpoint: string; bucket: string; region: string;
  accessKeyId: string; secretAccessKey: string;
  quarantinePrefix: string; finalPrefix: string; deadlineMs?: number;
};
export type StoredContent = { contentHash: string; byteLength: number; mimeType: RecordsMime };
export interface RecordsStorage {
  key(area: "quarantine" | "final", assetId: string, hash: string, mime: RecordsMime): string;
  readQuarantine(key: string, expected: StoredContent, signal?: AbortSignal): Promise<Buffer>;
  putQuarantine(key: string, bytes: Buffer, mime: RecordsMime, signal?: AbortSignal): Promise<void>;
  ensureFinal(key: string, bytes: Buffer, mime: RecordsMime, signal?: AbortSignal): Promise<void>;
  inspectFinal(key: string, expected: StoredContent, signal?: AbortSignal): Promise<boolean>;
  signedLink(key: string): Promise<string>;
  readFinal?(key:string,expected:StoredContent):Promise<Buffer>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const extensions: Record<RecordsMime, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
function endpoint(value: string, proxy: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ArtifactError("STORAGE_CONFIG_INVALID"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (!proxy && url.pathname !== "/")) throw new ArtifactError("STORAGE_CONFIG_INVALID");
  return url;
}
function prefix(value: string): string {
  if (!/^[a-z0-9][a-z0-9/-]*\/$/.test(value) || value.includes("//") || value.includes("..")) throw new ArtifactError("STORAGE_PREFIX_INVALID");
  return value;
}
function missing(error: unknown): boolean { return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404; }
function precondition(error: unknown): boolean { return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412; }

export class S3RecordsStorage implements RecordsStorage {
  private readonly client: S3Client;
  private readonly internal: URL;
  private readonly public: URL;
  private readonly deadlineMs: number;
  constructor(private readonly config: RecordsStorageConfig, client?: S3Client) {
    this.internal = endpoint(config.endpoint, false); this.public = endpoint(config.publicEndpoint, true);
    prefix(config.quarantinePrefix); prefix(config.finalPrefix);
    if (config.quarantinePrefix.startsWith(config.finalPrefix) || config.finalPrefix.startsWith(config.quarantinePrefix) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !config.accessKeyId?.trim() || !config.secretAccessKey?.trim() || !config.region?.trim()) throw new ArtifactError("STORAGE_CONFIG_INVALID");
    this.deadlineMs = config.deadlineMs ?? 15000;
    if (!Number.isInteger(this.deadlineMs) || this.deadlineMs < 100 || this.deadlineMs > 30000) throw new ArtifactError("STORAGE_CONFIG_INVALID");
    this.client = client ?? new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 1 });
  }
  key(area: "quarantine" | "final", assetId: string, hash: string, mime: RecordsMime): string {
    if (!UUID.test(assetId) || !HASH.test(hash) || !extensions[mime]) throw new ArtifactError("STORAGE_KEY_INVALID");
    return `${area === "quarantine" ? this.config.quarantinePrefix : this.config.finalPrefix}${assetId.toLowerCase()}/${hash}.${extensions[mime]}`;
  }
  private assertKey(key: string, area: "quarantine" | "final"): void {
    const expected = area === "quarantine" ? this.config.quarantinePrefix : this.config.finalPrefix;
    if (!key.startsWith(expected)) throw new ArtifactError("STORAGE_KEY_INVALID");
    const [asset, filename, extra] = key.slice(expected.length).split("/");
    if (extra !== undefined || !asset || !UUID.test(asset) || !filename || !/^[a-f0-9]{64}\.(pdf|png|jpg|webp)$/.test(filename)) throw new ArtifactError("STORAGE_KEY_INVALID");
  }
  private signal(parent?: AbortSignal): AbortSignal { return parent ? AbortSignal.any([parent, AbortSignal.timeout(this.deadlineMs)]) : AbortSignal.timeout(this.deadlineMs); }
  private async head(key: string, expected: StoredContent, signal: AbortSignal): Promise<boolean> {
    try {
      const value = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }), { abortSignal: signal });
      if (value.ContentLength !== expected.byteLength || value.ContentType !== expected.mimeType || value.Metadata?.sha256 !== expected.contentHash || value.Metadata?.schema !== "records-artifact-v1") throw new ArtifactError("STORAGE_OBJECT_CONFLICT");
      if (value.ChecksumSHA256 && value.ChecksumSHA256 !== Buffer.from(expected.contentHash, "hex").toString("base64")) throw new ArtifactError("STORAGE_OBJECT_CONFLICT");
      return true;
    } catch (error) { if (missing(error)) return false; if (error instanceof ArtifactError) throw error; throw new ArtifactError("STORAGE_UNAVAILABLE", true); }
  }
  private async read(key: string, expected: StoredContent, signal: AbortSignal): Promise<Buffer> {
    if (!HASH.test(expected.contentHash) || !Number.isSafeInteger(expected.byteLength) || expected.byteLength <= 0 || expected.byteLength > MAX_UPLOAD_BYTES || !extensions[expected.mimeType] || !key.endsWith(`/${expected.contentHash}.${extensions[expected.mimeType]}`)) throw new ArtifactError("STORAGE_EXPECTATION_INVALID");
    try {
      if (!await this.head(key, expected, signal)) throw new ArtifactError("STORAGE_OBJECT_MISSING", true);
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }), { abortSignal: signal });
      if (!response.Body || response.ContentLength !== expected.byteLength) throw new ArtifactError("STORAGE_OBJECT_CONFLICT");
      const stream = response.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
      const chunks: Buffer[] = []; let size = 0;
      const abort = () => stream.destroy?.(); signal.addEventListener("abort", abort, { once: true });
      try {
        for await (const chunk of stream) { size += chunk.length; if (size > expected.byteLength || size > MAX_UPLOAD_BYTES || signal.aborted) throw new ArtifactError("STORAGE_OBJECT_CONFLICT"); chunks.push(Buffer.from(chunk)); }
      } finally { signal.removeEventListener("abort", abort); if (size !== expected.byteLength) stream.destroy?.(); }
      const bytes = Buffer.concat(chunks);
      if (signal.aborted) throw new ArtifactError("STORAGE_UNAVAILABLE", true);
      if (bytes.length !== expected.byteLength || sha256(bytes) !== expected.contentHash) throw new ArtifactError("STORAGE_OBJECT_CONFLICT");
      return bytes;
    } catch (error) { if (error instanceof ArtifactError) throw error; throw new ArtifactError("STORAGE_UNAVAILABLE", true); }
  }
  async readQuarantine(key: string, expected: StoredContent, signal?: AbortSignal): Promise<Buffer> {
    this.assertKey(key, "quarantine"); return this.read(key, expected, this.signal(signal));
  }
  async inspectFinal(key: string, expected: StoredContent, signal?: AbortSignal): Promise<boolean> {
    this.assertKey(key, "final"); const bound = this.signal(signal);
    if (!await this.head(key, expected, bound)) return false;
    await this.read(key, expected, bound); return true;
  }
  private async put(area: "quarantine" | "final", key: string, bytes: Buffer, mime: RecordsMime, parent?: AbortSignal): Promise<void> {
    this.assertKey(key, area);
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES || !extensions[mime]) throw new ArtifactError("STORAGE_EXPECTATION_INVALID");
    const hash = sha256(bytes);
    if (!key.endsWith(`/${hash}.${extensions[mime]}`)) throw new ArtifactError("STORAGE_KEY_HASH_MISMATCH");
    const expected = { contentHash: hash, byteLength: bytes.length, mimeType: mime }; const signal = this.signal(parent);
    if (await this.head(key, expected, signal)) { await this.read(key, expected, signal); return; }
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: bytes, ContentType: mime, ContentLength: bytes.length, Metadata: { sha256: hash, schema: "records-artifact-v1" }, ChecksumSHA256: Buffer.from(hash, "hex").toString("base64"), IfNoneMatch: "*" }), { abortSignal: signal });
    } catch (error) { if (!precondition(error)) throw new ArtifactError("STORAGE_UNAVAILABLE", true); }
    // Lost write acknowledgements are resolved by inspecting this same immutable key.
    await this.read(key, expected, signal);
  }
  async putQuarantine(key: string, bytes: Buffer, mime: RecordsMime, signal?: AbortSignal): Promise<void> { await this.put("quarantine", key, bytes, mime, signal); }
  async ensureFinal(key: string, bytes: Buffer, mime: RecordsMime, signal?: AbortSignal): Promise<void> { await this.put("final", key, bytes, mime, signal); }
  async readFinal(key:string,expected:StoredContent){this.assertKey(key,"final");return this.read(key,expected,this.signal());}
  async signedLink(key: string): Promise<string> {
    this.assertKey(key, "final");
    const signed = new URL(await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.bucket, Key: key, ResponseCacheControl: "private, no-store", ResponseContentDisposition: "inline" }), { expiresIn: 300 }));
    if (signed.origin !== this.internal.origin) throw new ArtifactError("STORAGE_SIGNING_HOST_MISMATCH");
    return `${this.public.href.replace(/\/$/, "")}${signed.pathname}${signed.search}`;
  }
}
