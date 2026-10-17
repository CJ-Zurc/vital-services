import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { DomainError } from "../src/eda/contracts/actor.js";
import { createMeetProvider, MEET_SCOPE, type MeetProvider } from "../src/eda/modules/video/provider.js";
import { meetKeyring, encryptMeetSecret, decryptMeetSecret } from "../src/eda/modules/video/crypto.js";
import { normalizeMeetingUrl, hashMeetingUrl, validateMeetingUrl } from "../src/eda/modules/video/links.js";

const config = { clientId: "fixture-client", clientSecret: "fixture-client-secret", redirectUri: "https://vital.example/api/doctor/google-meet/callback" };
const verifier = "V".repeat(43);
const now = 1_700_000_000_000;
const tokenBody = { access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600, scope: `openid email ${MEET_SCOPE}` };
const identityBody = { sub: "google-fixture", email: "doctor@example.test", email_verified: true };
const spaceBody = { name: "spaces/fixture_123", meetingUri: "https://meet.google.com/abc-defg-hij", config: { accessType: "RESTRICTED" } };
const key = Buffer.alloc(32, 7);
const keyInput = { activeKeyId: "v1", keys: { v1: key.toString("base64") } };
const owner = "doctor-1";
function errorCode(code: string, status = 503) {
  return (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.ok(!JSON.stringify(error).includes("fixture-client-secret"));
    assert.ok(!error.message.includes("private-provider-body"));
    assert.equal(error.cause, undefined);
    return true;
  };
}
function fixture(value: unknown, status = 200) {
  return createMeetProvider(config, async () => Response.json(value, { status }), () => now);
}
function invoke(provider: MeetProvider, operation: string) {
  switch (operation) {
    case "exchange": return provider.exchangeCode("fixture-code", verifier);
    case "refresh": return provider.refresh("fixture-refresh");
    case "identity": return provider.identity("fixture-access");
    case "create": return provider.create("fixture-access");
    case "get": return provider.get("fixture-access", spaceBody.name);
    case "revoke": return provider.revoke("fixture-refresh");
    default: throw new Error("Unknown fixture operation");
  }
}
const operations = ["exchange", "refresh", "identity", "create", "get", "revoke"];

test("EDA Meet provider validates explicit configuration and credentials before transport", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({}); };
  for (const input of [
    { ...config, clientId: "" }, { ...config, clientSecret: "secret\n" },
    { ...config, redirectUri: "https://user:pass@vital.example/callback" },
    { ...config, redirectUri: "https://vital.example/callback#secret" },
    { ...config, redirectUri: "http://vital.example/callback" },
    ...[0, -1, 12_001, 1.5, NaN, Infinity].map(timeoutMs => ({ ...config, timeoutMs })),
  ]) assert.throws(() => createMeetProvider(input, fetcher), errorCode("VIDEO_PROVIDER_REJECTED"));
  createMeetProvider({ ...config, redirectUri: "http://localhost:3001/callback" }, fetcher);
  const p = createMeetProvider(config, fetcher);
  await assert.rejects(p.exchangeCode("code", "short"), errorCode("VIDEO_PROVIDER_REJECTED"));
  await assert.rejects(p.exchangeCode("", verifier), errorCode("VIDEO_PROVIDER_REJECTED"));
  for (const value of ["", "bad\r\nheader", "x".repeat(8193)]) {
    await assert.rejects(p.create(value), errorCode("VIDEO_PROVIDER_REJECTED"));
    await assert.rejects(p.refresh(value), errorCode("VIDEO_PROVIDER_REJECTED"));
    await assert.rejects(p.identity(value), errorCode("VIDEO_PROVIDER_REJECTED"));
    await assert.rejects(p.revoke(value), errorCode("VIDEO_PROVIDER_REJECTED"));
  }
  assert.equal(calls, 0);
});

test("EDA Meet provider pins endpoints and emits exact OAuth and restricted v2 contracts", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const p = createMeetProvider(config, async (url, init) => {
    calls.push({ url: String(url), init: init! });
    if (String(url).endsWith("/token")) return Response.json(tokenBody);
    if (String(url).endsWith("/userinfo")) return Response.json(identityBody);
    if (String(url).endsWith("/revoke")) return new Response(null, { status: 204 });
    return Response.json(spaceBody);
  }, () => now);
  assert.deepEqual(await p.exchangeCode("fixture-code", verifier), {
    accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: new Date(now + 3_600_000), scopes: ["openid", "email", MEET_SCOPE],
  });
  await p.refresh("fixture-refresh");
  assert.deepEqual(await p.identity("fixture-access"), { subject: identityBody.sub, email: identityBody.email });
  const space = { spaceName: spaceBody.name, meetingUrl: spaceBody.meetingUri };
  assert.deepEqual(await p.create("fixture-access"), space);
  assert.deepEqual(await p.get("fixture-access", spaceBody.name), space);
  assert.equal(await p.revoke("fixture-refresh"), undefined);
  assert.deepEqual(calls.map(call => call.url), [
    "https://oauth2.googleapis.com/token", "https://oauth2.googleapis.com/token",
    "https://openidconnect.googleapis.com/v1/userinfo", "https://meet.googleapis.com/v2/spaces",
    "https://meet.googleapis.com/v2/spaces/fixture_123", "https://oauth2.googleapis.com/revoke",
  ]);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body))), {
    grant_type: "authorization_code", code: "fixture-code", code_verifier: verifier, redirect_uri: config.redirectUri,
    client_id: config.clientId, client_secret: config.clientSecret,
  });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[1]!.init.body))), {
    grant_type: "refresh_token", refresh_token: "fixture-refresh", client_id: config.clientId, client_secret: config.clientSecret,
  });
  assert.deepEqual(JSON.parse(String(calls[3]!.init.body)), { config: { accessType: "RESTRICTED" } });
  assert.equal(String(calls[5]!.init.body), "token=fixture-refresh");
  for (const [index, call] of calls.entries()) {
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.method, ["POST", "POST", "GET", "POST", "GET", "POST"][index]);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("authorization"), index >= 2 && index <= 4 ? "Bearer fixture-access" : null);
    assert.equal(headers.get("content-type"), index < 2 || index === 5 ? "application/x-www-form-urlencoded" : index === 3 ? "application/json" : null);
  }
});

test("EDA Meet token results validate receipt fields and preserve nullable refresh tokens", async () => {
  const { refresh_token: _unused, ...withoutRefresh } = tokenBody;
  const result = await fixture(withoutRefresh).refresh("refresh");
  assert.equal(result.refreshToken, null);
  assert.deepEqual(result.scopes, ["openid", "email", MEET_SCOPE]);
  assert.equal((await fixture({ ...withoutRefresh, refresh_token: null }).refresh("refresh")).refreshToken, null);
  for (const patch of [
    { access_token: "" }, { access_token: "x".repeat(8193) }, { refresh_token: 3 }, { refresh_token: "" },
    { token_type: "MAC" }, { token_type: undefined }, { expires_in: "3600" }, { expires_in: 0 },
    { expires_in: 0.5 }, { expires_in: 31_536_001 }, { scope: undefined }, { scope: "openid\nemail" },
    { scope: " openid" }, { scope: "s".repeat(4097) }, { scope: "s ".repeat(128) + "s" },
  ]) {
    await assert.rejects(fixture({ ...tokenBody, ...patch }).refresh("refresh"), errorCode("VIDEO_PROVIDER_REJECTED"));
    await assert.rejects(fixture({ ...tokenBody, ...patch }).exchangeCode("code", verifier), errorCode("VIDEO_PROVIDER_UNCERTAIN"));
  }
  const p = createMeetProvider(config, async () => Response.json(tokenBody), () => NaN);
  await assert.rejects(p.refresh("refresh"), errorCode("VIDEO_PROVIDER_REJECTED"));
});

test("EDA Meet identity requires a bounded verified subject and email", async () => {
  for (const patch of [{ sub: "" }, { sub: "x".repeat(256) }, { email: "invalid" }, { email: "x".repeat(321) },
    { email: "doctor\n@example.test" }, { email_verified: false }, { email_verified: "true" }]) {
    await assert.rejects(fixture({ ...identityBody, ...patch }).identity("access"), errorCode("VIDEO_PROVIDER_REJECTED"));
  }
});

test("EDA Meet space reads reject unsafe paths and validate exact restricted recovery identity", async () => {
  let calls = 0;
  const p = createMeetProvider(config, async () => { calls++; return Response.json(spaceBody); });
  for (const name of ["https://evil.example/space", "spaces/../token", "spaces/x?access_token=secret", "spaces/x/y", "spaces/x#fragment", "spaces/", "spaces/" + "x".repeat(256)]) {
    await assert.rejects(p.get("access", name), errorCode("VIDEO_PROVIDER_REJECTED"));
  }
  assert.equal(calls, 0);
  await assert.rejects(p.get("access", "spaces/other"), errorCode("VIDEO_PROVIDER_REJECTED"));
  for (const patch of [{ name: "spaces/../x" }, { name: "spaces/x\n" }, { meetingUri: "https://meet.google.com/abc-defg-hij?secret=x" },
    { meetingUri: "https://meet.google.com.evil.test/abc-defg-hij" }, { meetingUri: "https://user@meet.google.com/abc-defg-hij" },
    { config: { accessType: "OPEN" } }, { config: null }]) {
    await assert.rejects(fixture({ ...spaceBody, ...patch }).create("access"), errorCode("VIDEO_PROVIDER_UNCERTAIN"));
    await assert.rejects(fixture({ ...spaceBody, ...patch }).get("access", spaceBody.name), errorCode("VIDEO_PROVIDER_REJECTED"));
  }
});

test("EDA Meet failures classify reconnect throttle rejection and uncertainty without retries or secrets", async () => {
  for (const operation of operations) {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      let calls = 0;
      const p = createMeetProvider(config, async () => { calls++; return Response.json({ secret: "private-provider-body" }, { status }); });
      const reason = status === 401 ? "RECONNECT_REQUIRED" : status === 429 ? "PROVIDER_THROTTLED"
        : status >= 500 && ["create", "exchange"].includes(operation) ? "PROVIDER_UNCERTAIN" : "PROVIDER_REJECTED";
      await assert.rejects(invoke(p, operation), errorCode(`VIDEO_${reason}`, status === 401 ? 409 : status === 429 ? 429 : 503));
      assert.equal(calls, 1);
    }
    await assert.rejects(invoke(fixture({ error: "invalid_grant", error_description: "private-provider-body" }, 400), operation), errorCode("VIDEO_RECONNECT_REQUIRED", 409));
    for (const thrown of [new Error("private-provider-body"), new DomainError(500, "SECRET", "private-provider-body")]) {
      let calls = 0;
      const p = createMeetProvider(config, async () => { calls++; throw thrown; });
      await assert.rejects(invoke(p, operation), errorCode(["create", "exchange"].includes(operation) ? "VIDEO_PROVIDER_UNCERTAIN" : "VIDEO_PROVIDER_REJECTED"));
      assert.equal(calls, 1);
    }
  }
});

test("EDA Meet redirects and malformed successful receipts fail closed", async () => {
  for (const operation of operations) {
    let calls = 0;
    const p = createMeetProvider(config, async (_url, init) => {
      calls++; assert.equal(init!.redirect, "error");
      return new Response("private-provider-body", { status: 302, headers: { location: "https://evil.example" } });
    });
    await assert.rejects(invoke(p, operation), errorCode(["create", "exchange"].includes(operation) ? "VIDEO_PROVIDER_UNCERTAIN" : "VIDEO_PROVIDER_REJECTED"));
    assert.equal(calls, 1);
  }
  for (const body of ["null", "[]", "not-json", "", "{}", '"private-provider-body"']) {
    const p = createMeetProvider(config, async () => new Response(body));
    for (const operation of operations.filter(value => value !== "revoke")) {
      await assert.rejects(invoke(p, operation), errorCode(["create", "exchange"].includes(operation) ? "VIDEO_PROVIDER_UNCERTAIN" : "VIDEO_PROVIDER_REJECTED"));
    }
  }
  const p = createMeetProvider(config, async () => { const response = Response.json(spaceBody); Object.defineProperty(response, "redirected", { value: true }); return response; });
  await assert.rejects(p.create("access"), errorCode("VIDEO_PROVIDER_UNCERTAIN"));
});

test("EDA Meet entire response byte bound covers success errors revoke and lying lengths", async () => {
  const json = JSON.stringify(spaceBody);
  const exact = json + " ".repeat(65_536 - Buffer.byteLength(json));
  assert.equal((await createMeetProvider(config, async () => new Response(exact)).create("access")).spaceName, spaceBody.name);
  for (const operation of operations) {
    for (const status of [200, 400]) {
      let cancelled = false;
      const p = createMeetProvider(config, async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(32_768)); controller.enqueue(new Uint8Array(32_769)); },
        cancel() { cancelled = true; },
      }), { status, headers: { "content-length": "1" } }));
      await assert.rejects(invoke(p, operation), errorCode(["create", "exchange"].includes(operation) ? "VIDEO_PROVIDER_UNCERTAIN" : "VIDEO_PROVIDER_REJECTED"));
      assert.equal(cancelled, true);
    }
  }
  let cancelled = false;
  const p = createMeetProvider(config, async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), { headers: { "content-length": "65537" } }));
  await assert.rejects(p.create("access"), errorCode("VIDEO_PROVIDER_UNCERTAIN"));
  assert.equal(cancelled, true);
  const unicode = createMeetProvider(config, async () => Response.json({ ...spaceBody, extra: "\u00e9".repeat(33_000) }));
  await assert.rejects(unicode.create("access"), errorCode("VIDEO_PROVIDER_UNCERTAIN"));
});

test("EDA Meet deadline bounds stalled fetch and cancels late responses without retry", { timeout: 3000 }, async () => {
  for (const operation of operations) {
    let finish!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    let calls = 0;
    const p = createMeetProvider({ ...config, timeoutMs: 10 }, async (_url, init) => {
      calls++; signal = init!.signal;
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    await assert.rejects(invoke(p, operation), errorCode(["create", "exchange"].includes(operation) ? "VIDEO_PROVIDER_UNCERTAIN" : "VIDEO_PROVIDER_REJECTED"));
    assert.equal(signal?.aborted, true);
    assert.equal(calls, 1);
    let cancelled = false;
    finish(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
    await setImmediate();
    assert.equal(cancelled, true);
  }
});

test("EDA Meet deadline includes stalled response bodies and uncooperative cancellation", { timeout: 3000 }, async () => {
  for (const operation of operations) {
    let cancelled = false;
    let signal: AbortSignal | null | undefined;
    const p = createMeetProvider({ ...config, timeoutMs: 10 }, async (_url, init) => {
      signal = init!.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
        cancel() { cancelled = true; return new Promise<void>(() => undefined); },
      }));
    });
    await assert.rejects(invoke(p, operation), errorCode(["create", "exchange"].includes(operation) ? "VIDEO_PROVIDER_UNCERTAIN" : "VIDEO_PROVIDER_REJECTED"));
    assert.equal(signal?.aborted, true);
    assert.equal(cancelled, true);
  }
});

test("EDA Meet crypto reads the Web envelope and preserves owner version AAD through rotation", () => {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`v1:${owner}`));
  const ciphertext = Buffer.concat([cipher.update("legacy-token", "utf8"), cipher.final()]);
  const legacy = ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
  const oldRing = meetKeyring(keyInput);
  assert.equal(decryptMeetSecret(oldRing, legacy, owner), "legacy-token");
  const rotated = meetKeyring({ activeKeyId: "v2", keys: { ...keyInput.keys, v2: key.toString("base64") } });
  assert.equal(decryptMeetSecret(rotated, legacy, owner), "legacy-token");
  const encrypted = encryptMeetSecret(rotated, "fixture-refresh", owner);
  assert.match(encrypted, /^v2\./);
  assert.equal(decryptMeetSecret(rotated, encrypted, owner), "fixture-refresh");
  assert.notEqual(encryptMeetSecret(rotated, "fixture-refresh", owner), encrypted);
  assert.throws(() => decryptMeetSecret(oldRing, encrypted, owner), errorCode("VIDEO_CRYPTO_INVALID"));
  assert.throws(() => decryptMeetSecret(rotated, encrypted, "doctor-2"), errorCode("VIDEO_CRYPTO_INVALID"));
  assert.throws(() => decryptMeetSecret(rotated, encrypted.replace(/^v2\./, "v1."), owner), errorCode("VIDEO_CRYPTO_INVALID"));
});

test("EDA Meet keyring rejects invalid noncanonical and unallowlisted keys without exposing material", () => {
  for (const input of [
    { activeKeyId: "absent", keys: keyInput.keys }, { ...keyInput, activeKeyId: "v1:owner" },
    { ...keyInput, keys: {} }, { ...keyInput, keys: { v1: "short" } },
    { ...keyInput, keys: { v1: key.toString("base64").replace(/=$/, "") } },
    { ...keyInput, keys: { v1: key.toString("base64") + "\n" } },
    { ...keyInput, keys: { v1: Buffer.alloc(31).toString("base64") } },
    { ...keyInput, keys: { v1: key.toString("base64"), "bad.version": key.toString("base64") } },
    { activeKeyId: "v0", keys: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`v${index}`, key.toString("base64")])) },
  ]) assert.throws(() => meetKeyring(input), errorCode("VIDEO_CRYPTO_INVALID"));
  const mutable = { activeKeyId: "v1", keys: { ...keyInput.keys } };
  const ring = meetKeyring(mutable);
  mutable.keys.v1 = Buffer.alloc(32, 9).toString("base64");
  const encrypted = encryptMeetSecret(ring, "secret", owner);
  assert.equal(decryptMeetSecret(meetKeyring(keyInput), encrypted, owner), "secret");
  assert.equal(JSON.stringify(ring), '{"activeKeyId":"v1"}');
  assert.ok(Object.isFrozen(ring));
  assert.throws(() => encryptMeetSecret({ activeKeyId: "v1" }, "secret", owner), errorCode("VIDEO_CRYPTO_INVALID"));
});

test("EDA Meet crypto rejects envelope tampering noncanonical base64 and invalid bounds", () => {
  const ring = meetKeyring(keyInput);
  const encrypted = encryptMeetSecret(ring, "fixture-refresh", owner);
  const [version, iv, tag, ciphertext] = encrypted.split(".") as [string, string, string, string];
  const altered = Buffer.from(ciphertext, "base64"); altered[0] = altered[0]! ^ 1;
  for (const value of [
    encrypted + ".", encrypted + ".extra", encrypted.slice(0, -1), "x".repeat(11_001),
    ["unknown", iv, tag, ciphertext].join("."), [version, "AA==", tag, ciphertext].join("."),
    [version, iv, "AA==", ciphertext].join("."), [version, iv, tag, ""].join("."),
    [version, iv + "=", tag, ciphertext].join("."), [version, iv, tag + "\n", ciphertext].join("."),
    [version, iv, tag, altered.toString("base64")].join("."),
  ]) assert.throws(() => decryptMeetSecret(ring, value, owner), errorCode("VIDEO_CRYPTO_INVALID"));
  const canonicalTag = tag.slice(0, -3) + "B==";
  assert.throws(() => decryptMeetSecret(ring, [version, iv, canonicalTag, ciphertext].join("."), owner), errorCode("VIDEO_CRYPTO_INVALID"));
  for (const badOwner of ["", "doctor:1", "doctor\n", "x".repeat(129)]) {
    assert.throws(() => encryptMeetSecret(ring, "secret", badOwner), errorCode("VIDEO_CRYPTO_INVALID"));
    assert.throws(() => decryptMeetSecret(ring, encrypted, badOwner), errorCode("VIDEO_CRYPTO_INVALID"));
  }
  for (const secret of ["", "x".repeat(8193), "\u00e9".repeat(4097), "\ud800"]) {
    assert.throws(() => encryptMeetSecret(ring, secret, owner), errorCode("VIDEO_CRYPTO_INVALID"));
  }
  for (const secret of ["x".repeat(8192), "\u00e9".repeat(4096)]) {
    assert.equal(decryptMeetSecret(ring, encryptMeetSecret(ring, secret, owner), owner), secret);
  }
});

test("EDA Meet link validation preserves Web normalization hashes and rejection contracts", () => {
  const value = validateMeetingUrl("GMEET", " https://MEET.GOOGLE.COM/abc-defg-hij/#fragment ");
  assert.deepEqual(value, { valid: true, normalizedUrl: spaceBody.meetingUri, urlHash: hashMeetingUrl(spaceBody.meetingUri), message: null });
  assert.equal(value.urlHash!.length, 64);
  assert.equal(normalizeMeetingUrl("http://meet.google.com/abc-defg-hij"), null);
  assert.equal(normalizeMeetingUrl("not a URL"), null);
  assert.equal(validateMeetingUrl("zoom", spaceBody.meetingUri).valid, false);
  for (const url of ["http://meet.google.com/abc-defg-hij", "https://user:secret@meet.google.com/abc-defg-hij",
    "https://meet.google.com:444/abc-defg-hij", "https://meet.google.com.evil.test/abc-defg-hij", "https://meet.google.com/invalid"]) {
    assert.equal(validateMeetingUrl("gmeet", url).valid, false);
  }
  assert.equal(validateMeetingUrl("gmeet", spaceBody.meetingUri + "?authuser=1#fragment").normalizedUrl, spaceBody.meetingUri + "?authuser=1");
});
