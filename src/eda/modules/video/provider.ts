import { DomainError } from "../../contracts/actor.js";

export const MEET_SCOPE = "https://www.googleapis.com/auth/meetings.space.created";
const endpoints = {
  token: "https://oauth2.googleapis.com/token",
  identity: "https://openidconnect.googleapis.com/v1/userinfo",
  spaces: "https://meet.googleapis.com/v2/spaces",
  revoke: "https://oauth2.googleapis.com/revoke",
} as const;
const maxBytes = 65_536;
const maxDeadlineMs = 12_000;
type Failure = "RECONNECT_REQUIRED" | "PROVIDER_THROTTLED" | "PROVIDER_REJECTED" | "PROVIDER_UNCERTAIN";
export type MeetTokens = { accessToken: string; refreshToken: string | null; expiresAt: Date; scopes: string[] };
export type MeetIdentity = { subject: string; email: string };
export type MeetSpace = { spaceName: string; meetingUrl: string };
export interface MeetProvider {
  exchangeCode(code: string, verifier: string): Promise<MeetTokens>;
  refresh(refreshToken: string): Promise<MeetTokens>;
  identity(accessToken: string): Promise<MeetIdentity>;
  create(accessToken: string): Promise<MeetSpace>;
  get(accessToken: string, spaceName: string): Promise<MeetSpace>;
  revoke(token: string): Promise<void>;
}

class ProviderFailure extends DomainError {
  constructor(reason: Failure) {
    super(reason === "RECONNECT_REQUIRED" ? 409 : reason === "PROVIDER_THROTTLED" ? 429 : 503,
      `VIDEO_${reason}`, "Google Meet could not complete the request.");
  }
}
function fail(reason: Failure): never { throw new ProviderFailure(reason); }
function text(value: unknown, limit = 8192): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && /^[\x21-\x7e]+$/.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function spaceName(value: unknown): value is string {
  return text(value, 256) && /^spaces\/[A-Za-z0-9_-]+$/.test(value);
}
function redirectUri(value: unknown): value is string {
  if (!text(value, 2048) || /\\/.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && (url.protocol === "https:"
      || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}

export function createMeetProvider(config: {
  clientId: string; clientSecret: string; redirectUri: string; timeoutMs?: number;
}, fetcher: typeof fetch = fetch, clock: () => number = Date.now): MeetProvider {
  const timeoutMs = config.timeoutMs ?? maxDeadlineMs;
  if (!text(config.clientId, 1024) || !text(config.clientSecret) || !redirectUri(config.redirectUri)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxDeadlineMs) fail("PROVIDER_REJECTED");
  const { clientId, clientSecret, redirectUri: callback } = config;

  async function request(url: string, init: RequestInit, uncertain: boolean, empty = false): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fallback: Failure = uncertain ? "PROVIDER_UNCERTAIN" : "PROVIDER_REJECTED";
    const cancel = () => { if (reader) void reader.cancel().catch(() => undefined); };
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ProviderFailure(fallback));
        controller.abort();
        cancel();
      }, timeoutMs);
    });
    const run = async () => {
      const response = await fetcher(url, { ...init, redirect: "error", cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) {
        if (response.body) void response.body.cancel().catch(() => undefined);
        fail(fallback);
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        if (response.body) void response.body.cancel().catch(() => undefined);
        fail(fallback);
      }
      const length = response.headers.get("content-length");
      if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
        if (response.body) void response.body.cancel().catch(() => undefined);
        fail(fallback);
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (response.body) {
        reader = response.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (controller.signal.aborted) fail(fallback);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maxBytes) fail(fallback);
            chunks.push(chunk.value);
          }
        } finally {
          // Cancellation is best-effort: an uncooperative source must not extend the deadline.
          cancel();
          reader.releaseLock();
          reader = undefined;
        }
      }
      let payload: unknown;
      if (!(empty && response.ok)) {
        try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { payload = null; }
      }
      if (!response.ok) {
        if (response.status === 401 || (record(payload) && payload.error === "invalid_grant")) fail("RECONNECT_REQUIRED");
        if (response.status === 429) fail("PROVIDER_THROTTLED");
        fail(uncertain && response.status >= 500 ? "PROVIDER_UNCERTAIN" : "PROVIDER_REJECTED");
      }
      if (empty) return {};
      if (!record(payload)) fail(fallback);
      return payload;
    };
    try { return await Promise.race([run(), deadline]); }
    catch (error) {
      if (error instanceof ProviderFailure) throw error;
      return fail(fallback);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      cancel();
    }
  }

  function tokens(value: Record<string, unknown>, uncertain: boolean): MeetTokens {
    const invalid: Failure = uncertain ? "PROVIDER_UNCERTAIN" : "PROVIDER_REJECTED";
    if (!text(value.access_token) || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"
      || (value.refresh_token !== undefined && value.refresh_token !== null && !text(value.refresh_token))
      || typeof value.expires_in !== "number" || !Number.isSafeInteger(value.expires_in)
      || value.expires_in < 1 || value.expires_in > 31_536_000
      || typeof value.scope !== "string" || value.scope.length > 4096
      || (value.scope !== "" && !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(value.scope))) fail(invalid);
    const scopes = value.scope === "" ? [] : value.scope.split(" ");
    if (scopes.length > 128 || scopes.some(scope => scope.length > 256)) fail(invalid);
    const expiresAt = new Date(clock() + value.expires_in * 1000);
    if (!Number.isFinite(expiresAt.getTime())) fail(invalid);
    return { accessToken: value.access_token, refreshToken: (value.refresh_token as string | null | undefined) ?? null, expiresAt, scopes };
  }
  function space(value: Record<string, unknown>, uncertain: boolean, expected?: string): MeetSpace {
    if (!spaceName(value.name) || (expected !== undefined && value.name !== expected)
      || !text(value.meetingUri, 128) || !/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(value.meetingUri)
      || !record(value.config) || value.config.accessType !== "RESTRICTED") fail(uncertain ? "PROVIDER_UNCERTAIN" : "PROVIDER_REJECTED");
    return { spaceName: value.name, meetingUrl: value.meetingUri };
  }
  function credential(value: string) { if (!text(value)) fail("PROVIDER_REJECTED"); }
  async function token(params: Record<string, string>, uncertain: boolean) {
    return tokens(await request(endpoints.token, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }),
    }, uncertain), uncertain);
  }
  return {
    async exchangeCode(code, verifier) {
      credential(code);
      if (!text(verifier, 128) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) fail("PROVIDER_REJECTED");
      return token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback }, true);
    },
    async refresh(refreshToken) {
      credential(refreshToken);
      return token({ grant_type: "refresh_token", refresh_token: refreshToken }, false);
    },
    async identity(accessToken) {
      credential(accessToken);
      const value = await request(endpoints.identity, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } }, false);
      if (!text(value.sub, 255) || !text(value.email, 320) || !/^[^@]+@[^@]+$/.test(value.email) || value.email_verified !== true) fail("PROVIDER_REJECTED");
      return { subject: value.sub, email: value.email };
    },
    async create(accessToken) {
      credential(accessToken);
      return space(await request(endpoints.spaces, { method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ config: { accessType: "RESTRICTED" } }),
      }, true), true);
    },
    async get(accessToken, name) {
      credential(accessToken);
      if (!spaceName(name)) fail("PROVIDER_REJECTED");
      return space(await request(`${endpoints.spaces}/${name.slice("spaces/".length)}`,
        { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } }, false), false, name);
    },
    async revoke(value) {
      credential(value);
      await request(endpoints.revoke, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: value }),
      }, false, true);
    },
  };
}
