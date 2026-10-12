import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { requestHash, verifyActorAssertion } from "../src/eda/infrastructure/security.js";
import { actorSchema, requireScope } from "../src/eda/contracts/actor.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = { publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), keyId: "test-key", issuer: "vital-web", audience: "vital-services", peerName: "vital-web" };
const now = 2_000_000_000;
const actor = { authId: randomUUID(), role: "patient" as const, serviceId: "vital-web" as const,
  scopes: ["profile.write"], resource: "self", correlationId: randomUUID(), isSuperAdmin: false };
const body = { emergencyContactName: "Test" };
const path = "/internal/v1/profile/patient/me";
function signed(overrides: Record<string, unknown> = {}, key = privateKey) {
  return jwt.sign({ iss: config.issuer, aud: config.audience, sub: actor.authId, iat: now, exp: now + 60,
    jti: randomUUID(), actor, action: `PATCH ${path}`, requestHash: requestHash("PATCH", path, body), ...overrides },
  key, { algorithm: "RS256", keyid: config.keyId });
}
const verify = (token: string, overrides: Record<string, unknown> = {}) => verifyActorAssertion({ token, peerAuthorized: true,
  peerName: "vital-web", method: "PATCH", path, body, config, now, ...overrides });

test("EDA actor assertions require both mTLS peer identity and a valid scoped signature", () => {
  assert.deepEqual(verify(signed()), actor);
  assert.throws(() => verify(signed(), { peerAuthorized: false }));
  assert.throws(() => verify(signed(), { peerName: "another-service" }));
  assert.throws(() => verify(signed({}, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey)));
});

test("EDA actor assertions reject wrong audience, lifetime, clock, subject and request substitution", () => {
  for (const overrides of [{ aud: "uhse-auth" }, { exp: now + 61 }, { iat: now + 10, exp: now + 60 },
    { sub: randomUUID() }, { jti: undefined }, { jti: "" }, { jti: "not-an-operation-id" }, { exp: now - 10 }]) assert.throws(() => verify(signed(overrides)));
  assert.throws(() => verify(signed(), { body: { emergencyContactName: "Changed" } }));
  assert.throws(() => verify(signed(), { method: "POST" }));
  assert.throws(() => verify(signed(), { path: "/internal/v1/profile/doctor/me" }));
});

test("EDA delegated resource scope is checked separately from signature validity", () => {
  const verified = verify(signed());
  requireScope(verified, "profile.write", "self");
  assert.throws(() => requireScope(verified, "profile.roles.read", "self"));
  assert.throws(() => requireScope(verified, "profile.write", randomUUID()));
  assert.throws(() => actorSchema.parse({ ...actor, accessToken: "must-not-be-accepted" }));
});

test("EDA mutation hashes canonicalize object keys but preserve action and value differences", () => {
  assert.equal(requestHash("post", path, { b: 2, a: 1 }), requestHash("POST", path, { a: 1, b: 2 }));
  assert.notEqual(requestHash("POST", path, [1, 2]), requestHash("POST", path, [2, 1]));
  assert.notEqual(requestHash("POST", path, body), requestHash("PATCH", path, body));
});

test("EDA signing-key overlap accepts only configured keys and rejects a retired key", () => {
  const next = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const overlap = { ...config, keyId: "next-key", publicKey: next.publicKey.export({ type: "spki", format: "pem" }).toString(),
    previousKeys: { [config.keyId]: config.publicKey } };
  assert.deepEqual(verify(signed(), { config: overlap }), actor);
  assert.throws(() => verify(signed(), { config: { ...overlap, previousKeys: undefined } }));
  assert.throws(() => verify(signed(), { config: { ...overlap, previousKeys: {} } }));
});
