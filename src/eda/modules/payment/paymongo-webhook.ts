import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { z } from "zod";
import { DomainError, type Actor } from "../../contracts/actor.js";
import { schedulePaymongoWebhook } from "./payment-store.js";

const limit = 32 * 1024;
const envelope = z.object({
  rawBodyBase64: z.base64().min(4).max(Math.ceil(limit / 3) * 4),
  signature: z.string().min(1).max(512),
}).strict();
const event = z.object({ data: z.object({
  id: z.string().regex(/^evt_[a-z0-9]+$/i).max(128),
  type: z.literal("event"),
  attributes: z.object({ livemode: z.literal(false), type: z.string(), data: z.unknown().optional() }),
}) });
const checkout = z.object({
  id: z.string().regex(/^cs_[a-z0-9]+$/i).max(128),
  type: z.literal("checkout_session"),
});

export function verifyPaymongoWebhook(input: unknown, secret: string, now = Date.now()) {
  const { rawBodyBase64, signature } = envelope.parse(input);
  const raw = Buffer.from(rawBodyBase64, "base64");
  if (raw.length > limit) throw new DomainError(413, "PAYMENT_WEBHOOK_TOO_LARGE", "Webhook body is too large.");
  const fields = signature.split(",").map(part => part.trim().split("="));
  const parts = new Map(fields.map(([name, value]) => [name, value]));
  const stamp = parts.get("t") ?? "";
  const test = parts.get("te") ?? "";
  const invalid = () => new DomainError(401, "PAYMENT_WEBHOOK_SIGNATURE_INVALID", "Webhook signature is invalid.");
  if (fields.some((part) => part.length !== 2) || parts.size !== fields.length
    || !/^\d{10}$/.test(stamp) || !/^[a-f0-9]{64}$/i.test(test) || parts.get("li")
    || Math.abs(now - Number(stamp) * 1000) > 300_000) throw invalid();
  const expected = createHmac("sha256", secret).update(stamp + ".").update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(test, "hex"))) throw invalid();
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { throw new DomainError(400, "PAYMENT_WEBHOOK_INVALID", "Webhook payload is invalid."); }
  const { data } = event.parse(payload);
  if (data.attributes.type !== "checkout_session.payment.paid") return null;
  return { eventId: data.id, checkoutId: checkout.parse(data.attributes.data).id };
}

export function createPaymongoWebhook(pool: Pool, environment: NodeJS.ProcessEnv) {
  if (environment.VITAL_PAYMONGO_WEBHOOK_ENABLED !== "true") return undefined;
  const path = environment.VITAL_PAYMONGO_WEBHOOK_SECRET_FILE;
  if (!path) throw new Error("PAYMENT_WEBHOOK_SECRET_REQUIRED");
  const secret = readFileSync(path, "utf8").trim();
  if (!secret) throw new Error("PAYMENT_WEBHOOK_SECRET_REQUIRED");
  return async (actor: Actor, body: unknown) => {
    if (actor.role !== "service" || actor.serviceId !== "vital-web" || actor.isSuperAdmin
      || actor.resource !== "payments:paymongo-webhook"
      || actor.scopes.length !== 1 || actor.scopes[0] !== "payments.webhook.receive") {
      throw new DomainError(403, "PAYMENT_WEBHOOK_ACTOR_DENIED", "Webhook relay is not authorized.");
    }
    const verified = verifyPaymongoWebhook(body, secret);
    if (verified) {
      try { await schedulePaymongoWebhook(pool, verified.checkoutId, verified.eventId); }
      catch { throw new DomainError(503, "PAYMENT_WEBHOOK_RETRY", "Webhook delivery can be retried."); }
    }
    return { received: true };
  };
}
