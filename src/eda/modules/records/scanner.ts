import { connect } from "node:net";
import { lstat, readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { ArtifactError, MAX_UPLOAD_BYTES, assertUploadSize, sha256 } from "./upload-validation.js";

export type ScanEvidence = { engine: "clamav"; engineVersion: string; databaseVersion: number; databaseDate: string; scannedAt: string; contentHash: string; byteLength: number; verdict: "clean" };
export interface RecordsScanner { scan(bytes: Buffer, signal?: AbortSignal): Promise<ScanEvidence> }
export type ClamAvConfig = { socketPath: string; daemonConfigPath: string; deadlineMs: number; maxDatabaseAgeMs: number };
export type ClamAvIo = {
  policy(config: ClamAvConfig): Promise<void>;
  connect(socketPath: string, signal: AbortSignal): Promise<Duplex>;
};
function unixPath(value: string): void {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\\") || value.split("/").includes("..") || value.includes(":") || value.length > 100) throw new ArtifactError("SCANNER_CONFIG_INVALID");
}
function sizeDirective(value: string | undefined): number {
  const result = /^(\d+)([KMG])?$/i.exec(value ?? "");
  if (!result) throw new ArtifactError("SCANNER_POLICY_UNVERIFIED", true);
  return Number(result[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[result[2]?.toUpperCase() ?? ""] ?? 1);
}
export function verifyClamAvPolicy(text: string, config: ClamAvConfig): void {
  if (Buffer.byteLength(text) > 65536) throw new ArtifactError("SCANNER_POLICY_UNVERIFIED", true);
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const pair = /^(\w+)\s+(.+)$/.exec(line);
    if (!pair || values.has(pair[1]!)) throw new ArtifactError("SCANNER_POLICY_UNVERIFIED", true);
    values.set(pair[1]!, pair[2]!.trim());
  }
  if (values.has("TCPSocket") || values.get("LocalSocket") !== config.socketPath || values.get("AlertExceedsMax") !== "yes" || values.get("AlertEncrypted") !== "yes" || values.get("ScanPDF") !== "yes" || values.get("ScanArchive") !== "yes") throw new ArtifactError("SCANNER_POLICY_UNVERIFIED", true);
  if (sizeDirective(values.get("StreamMaxLength")) < MAX_UPLOAD_BYTES || sizeDirective(values.get("MaxFileSize")) < MAX_UPLOAD_BYTES || sizeDirective(values.get("MaxScanSize")) < 50 * 1024 * 1024) throw new ArtifactError("SCANNER_POLICY_UNVERIFIED", true);
}
async function localPolicy(config: ClamAvConfig): Promise<void> {
  unixPath(config.socketPath); unixPath(config.daemonConfigPath);
  const socket = await lstat(config.socketPath);
  const file = await lstat(config.daemonConfigPath);
  if (!socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o007) !== 0 || !file.isFile() || file.isSymbolicLink() || file.size > 65536 || (file.mode & 0o022) !== 0) throw new ArtifactError("SCANNER_POLICY_UNVERIFIED", true);
  verifyClamAvPolicy(await readFile(config.daemonConfigPath, "utf8"), config);
}
const nativeIo: ClamAvIo = {
  policy: localPolicy,
  connect: (socketPath, signal) => new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath, signal });
    socket.once("error", reject); socket.once("connect", () => { socket.removeListener("error", reject); resolve(socket); });
  }),
};
function databaseVersion(reply: string, now: number, maximumAge: number): Omit<ScanEvidence, "contentHash" | "byteLength" | "scannedAt" | "verdict"> {
  const match = /^ClamAV ([\w.+-]+)\/(\d+)\/(.+)$/.exec(reply);
  if (!match) throw new ArtifactError("SCANNER_VERSION_INVALID", true);
  // ClamAV's unzoned signature date is interpreted as UTC; daemon TZ=UTC is an activation requirement.
  const timestamp = Date.parse(/(?:Z|GMT|UTC|[+-]\d{4})$/.test(match[3]!) ? match[3]! : `${match[3]} UTC`);
  if (!Number.isFinite(timestamp) || timestamp > now + 300000 || now - timestamp > maximumAge) throw new ArtifactError("SCANNER_DATABASE_STALE", true);
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) throw new ArtifactError("SCANNER_VERSION_INVALID", true);
  return { engine: "clamav", engineVersion: match[1]!, databaseVersion: version, databaseDate: new Date(timestamp).toISOString() };
}
export function instreamRequest(bytes: Buffer): Buffer {
  assertUploadSize(bytes);
  const parts: Buffer[] = [Buffer.from("zINSTREAM\0")];
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const chunk = bytes.subarray(offset, offset + 65536); const length = Buffer.alloc(4); length.writeUInt32BE(chunk.length); parts.push(length, chunk);
  }
  parts.push(Buffer.alloc(4)); return Buffer.concat(parts);
}

export class ClamAvScanner implements RecordsScanner {
  constructor(private readonly config: ClamAvConfig, private readonly io: ClamAvIo = nativeIo, private readonly now: () => number = Date.now) {
    unixPath(config.socketPath); unixPath(config.daemonConfigPath);
    if (!Number.isInteger(config.deadlineMs) || config.deadlineMs < 100 || config.deadlineMs > 30000 || !Number.isInteger(config.maxDatabaseAgeMs) || config.maxDatabaseAgeMs < 60000 || config.maxDatabaseAgeMs > 48 * 3600000) throw new ArtifactError("SCANNER_CONFIG_INVALID");
  }
  private async exchange(request: Buffer, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new ArtifactError("SCANNER_UNAVAILABLE", true);
    let socket: Duplex | undefined;
    return new Promise<string>((resolve, reject) => {
      let complete = false; let bytes = Buffer.alloc(0);
      const finish = (error?: Error, value?: string) => {
        if (complete) return; complete = true; signal.removeEventListener("abort", abort); socket?.destroy();
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(new ArtifactError("SCANNER_TIMEOUT", true));
      signal.addEventListener("abort", abort, { once: true });
      void this.io.connect(this.config.socketPath, signal).then(connection => {
        socket = connection; if (complete || signal.aborted) { connection.destroy(); return; }
        connection.on("error", () => finish(new ArtifactError("SCANNER_UNAVAILABLE", true)));
        connection.on("end", () => finish(new ArtifactError("SCANNER_VERDICT_INVALID", true)));
        connection.on("close", () => finish(new ArtifactError("SCANNER_VERDICT_INVALID", true)));
        connection.on("data", (chunk: Buffer) => {
          bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
          if (bytes.length > 4096) { finish(new ArtifactError("SCANNER_VERDICT_INVALID", true)); return; }
          const end = bytes.indexOf(0);
          if (end !== -1) {
            if (end !== bytes.length - 1) finish(new ArtifactError("SCANNER_VERDICT_INVALID", true));
            else finish(undefined, bytes.subarray(0, end).toString("utf8"));
          }
        });
        connection.write(request, error => { if (error) finish(new ArtifactError("SCANNER_UNAVAILABLE", true)); });
      }, () => finish(new ArtifactError("SCANNER_UNAVAILABLE", true)));
    });
  }
  async scan(input: Buffer, parent?: AbortSignal): Promise<ScanEvidence> {
    assertUploadSize(input); const bytes = Buffer.from(input);
    const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(this.config.deadlineMs)]) : AbortSignal.timeout(this.config.deadlineMs);
    try {
      await this.io.policy(this.config);
      const version = databaseVersion(await this.exchange(Buffer.from("zVERSION\0"), signal), this.now(), this.config.maxDatabaseAgeMs);
      const verdict = await this.exchange(instreamRequest(bytes), signal);
      if (verdict !== "stream: OK") {
        if (/^stream: .+ FOUND$/.test(verdict)) throw new ArtifactError("UPLOAD_MALWARE_OR_SCAN_LIMIT");
        throw new ArtifactError("SCANNER_VERDICT_INVALID", true);
      }
      const after = databaseVersion(await this.exchange(Buffer.from("zVERSION\0"), signal), this.now(), this.config.maxDatabaseAgeMs);
      if (after.databaseVersion !== version.databaseVersion || after.engineVersion !== version.engineVersion || after.databaseDate !== version.databaseDate) throw new ArtifactError("SCANNER_DATABASE_CHANGED", true);
      return { ...after, scannedAt: new Date(this.now()).toISOString(), contentHash: sha256(bytes), byteLength: bytes.length, verdict: "clean" };
    } catch (error) { if (error instanceof ArtifactError) throw error; throw new ArtifactError("SCANNER_UNAVAILABLE", true); }
  }
}
