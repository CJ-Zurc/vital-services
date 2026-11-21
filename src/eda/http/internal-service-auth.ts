import { type RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { DomainError } from "../contracts/actor.js";

function safeCompare(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createInternalServiceAuth(expectedService = "trace"): RequestHandler {
  return (req, res, next) => {
    try {
      const service = req.get("X-Internal-Service");
      const key = req.get("X-Internal-Service-Key");
      const correlationId = req.get("X-Correlation-ID");

      if (correlationId) {
        res.set("X-Correlation-ID", correlationId);
      }

      const expectedKey = process.env.VITAL_INTERNAL_SERVICE_KEY || "BGH_LOCAL_INTERNAL_API_KEY_2026";

      if (service !== expectedService || !safeCompare(key, expectedKey)) {
        throw new DomainError(403, "FORBIDDEN_UNTRUSTED_INTERNAL_SERVICE", "Untrusted internal service caller.");
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
