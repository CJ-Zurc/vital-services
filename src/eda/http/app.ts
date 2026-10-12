import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import type { TLSSocket } from "node:tls";
import jwt from "jsonwebtoken";
import { z, ZodError } from "zod";
import { DomainError } from "../contracts/actor.js";
import { verifyActorAssertion, type AssertionConfig } from "../infrastructure/security.js";
import type { CorePrismaClient } from "../infrastructure/databases.js";
import { createProfileRouter } from "./profile-router.js";
import { createProfileCommandGuard } from "../modules/core/profile-commands.js";

export function createEdaApp(core: CorePrismaClient, assertion: AssertionConfig, profileWrites = false) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  app.get("/health", (_req, res) => res.json({ success: true, data: { service: "vital-services-eda", mode: "api", migrationComplete: false } }));
  const delegation: RequestHandler = (req, res, next) => {
    try {
      const peer = req.socket as TLSSocket;
      const token = req.get("X-Vital-Actor-Assertion") ?? "";
      const peerName = peer.getPeerCertificate?.().subject?.CN;
      res.locals.actor = verifyActorAssertion({ token, peerAuthorized: peer.authorized === true,
        peerName: typeof peerName === "string" ? peerName : "", method: req.method,
        path: req.originalUrl, body: req.body ?? null, config: assertion });
      res.set("X-Correlation-ID", res.locals.actor.correlationId);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const claims = jwt.decode(token);
        if (!claims || typeof claims === "string") throw new DomainError(401, "INVALID_COMMAND", "Verified command ID required.");
        res.locals.command = { operationId: z.uuid().parse(claims.jti), requestHash: z.string().regex(/^[a-f0-9]{64}$/).parse(claims.requestHash) };
      }
      next();
    } catch (error) { next(error); }
  };
  app.use("/internal/v1", delegation);
  app.use("/internal/v1/profile", createProfileRouter(core, { commandGuard: profileWrites ? createProfileCommandGuard() : undefined }));
  app.use((_req, res) => res.status(404).json({ success: false, code: "ROUTE_NOT_EXTRACTED", message: "This route has not passed extraction acceptance." }));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof DomainError) res.status(error.status).json({ success: false, code: error.code, message: error.message });
    else if (error instanceof ZodError) res.status(400).json({ success: false, code: "INVALID_INPUT", message: "Invalid request." });
    else if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") res.status(413).json({ success: false, code: "BODY_TOO_LARGE" });
    else res.status(500).json({ success: false, code: "REQUEST_FAILED", message: "VITAL request failed." });
  };
  app.use(errors);
  return app;
}
