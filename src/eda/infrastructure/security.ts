import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { actorSchema, DomainError, type Actor } from "../contracts/actor.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(JSON.stringify({ method: method.toUpperCase(), path, body: canonical(body ?? null) })).digest("hex");
}

export interface AssertionConfig {
  publicKey: string;
  keyId: string;
  issuer: string;
  audience: string;
  peerName: string;
  previousKeys?: Readonly<Record<string, string>>;
}

export function verifyActorAssertion(input: {
  token: string;
  peerAuthorized: boolean;
  peerName: string;
  method: string;
  path: string;
  body: unknown;
  config: AssertionConfig;
  now?: number;
}): Actor {
  const deny = () => new DomainError(401, "INVALID_ACTOR_ASSERTION", "A verified delegated action is required.");
  if (!input.peerAuthorized || input.peerName !== input.config.peerName || !input.config.publicKey || !input.config.keyId || input.token.length > 8192) throw deny();
  try {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const header = jwt.decode(input.token, { complete: true })?.header;
    if (!header || typeof header.kid !== "string") throw deny();
    const verificationKey = header.kid === input.config.keyId ? input.config.publicKey :
      input.config.previousKeys && Object.hasOwn(input.config.previousKeys, header.kid) ? input.config.previousKeys[header.kid] : undefined;
    if (!verificationKey) throw deny();
    const decoded = jwt.verify(input.token, verificationKey, {
      algorithms: ["RS256"], issuer: input.config.issuer, audience: input.config.audience,
      clockTolerance: 5, clockTimestamp: now, complete: true,
    });
    if (typeof decoded !== "object" || decoded.header.kid !== header.kid || typeof decoded.payload === "string") throw deny();
    const claims = decoded.payload;
    if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp! <= claims.iat! || claims.exp! - claims.iat! > 60 || claims.iat! > now + 5 || !z.uuid().safeParse(claims.jti).success) throw deny();
    if (claims.action !== `${input.method.toUpperCase()} ${input.path}` || claims.requestHash !== requestHash(input.method, input.path, input.body)) throw deny();
    const actor = actorSchema.parse(claims.actor);
    if (claims.sub !== actor.authId || actor.serviceId !== input.config.peerName) throw deny();
    return actor;
  } catch {
    throw deny();
  }
}
