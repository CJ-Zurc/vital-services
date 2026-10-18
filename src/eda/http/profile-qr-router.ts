import express, { Router, type RequestHandler } from "express";
import type { TLSSocket } from "node:tls";
import { z } from "zod";
import { DomainError } from "../contracts/actor.js";
import { verifyActorAssertion, type AssertionConfig } from "../infrastructure/security.js";
import { PROFILE_QR_LIMIT, profileQrDescriptor } from "../modules/profile/profile-qr-contracts.js";
import type { ProfileQrModule } from "../modules/profile/profile-qr.js";

// Mount before the application's JSON parser. The normal delegation middleware must still run afterwards.
export function createProfileQrUploadIngress(assertion: AssertionConfig): Router {
  const router = Router(); let active = 0;
  router.post("/internal/v1/profile/doctor/payment-qr", (req, res, next) => {
    try {
      const raw = req.get("X-Vital-Upload-Descriptor") ?? "";
      if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new DomainError(400, "PROFILE_QR_DESCRIPTOR_INVALID", "Invalid QR descriptor.");
      const descriptor = profileQrDescriptor.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
      const peer = req.socket as TLSSocket, name = peer.getPeerCertificate?.().subject?.CN;
      const actor = verifyActorAssertion({ token: req.get("X-Vital-Actor-Assertion") ?? "", peerAuthorized: peer.authorized === true,
        peerName: typeof name === "string" ? name : "", method: req.method, path: req.originalUrl, body: descriptor, config: assertion });
      if (actor.role !== "doctor" || actor.resource !== actor.authId || actor.scopes.length !== 1 || actor.scopes[0] !== "profile.qr.write") throw new DomainError(403, "PROFILE_QR_SCOPE_DENIED", "QR write denied.");
      if (req.get("Content-Type") !== "application/octet-stream" || req.get("Content-Encoding") || req.get("Transfer-Encoding") || req.get("Content-Length") !== String(descriptor.byteLength)) throw new DomainError(400, "PROFILE_QR_ENVELOPE_INVALID", "Bounded QR bytes required.");
      if (active >= 2) throw new DomainError(429, "PROFILE_QR_CAPACITY_LIMIT", "QR capacity occupied.");
      active++; let released = false;
      const release = () => { if (!released) { released = true; active--; } };
      res.once("finish", release); res.once("close", release);
      res.locals.uploadDescriptor = descriptor; next();
    } catch (error) { next(error); }
  }, express.raw({ type: "application/octet-stream", limit: PROFILE_QR_LIMIT, inflate: false }));
  return router;
}
export function createProfileQrRouter(owner?: ProfileQrModule): Router {
  const router = Router();
  router.use((_req, _res, next) => next(owner ? undefined : new DomainError(503, "PROFILE_QR_OWNER_DISABLED", "QR extraction is disabled.")));
  const handle = (run: (req: express.Request, res: express.Response) => Promise<unknown>): RequestHandler => async (req, res) => {
    if (!res.locals.actor) throw new DomainError(401, "ACTOR_REQUIRED", "Validated actor required.");
    const data = await run(req, res);
    res.set("Cache-Control", "private, no-store");
    const pending = data !== null && typeof data === "object" && "operationStatus" in data && data.operationStatus === "pending";
    if (pending) res.set("Retry-After", "5");
    res.status(pending ? 202 : 200).json({ success: true, contractVersion: 1, data });
  };
  const meta = (res: express.Response) => {
    if (!res.locals.command) throw new DomainError(401, "COMMAND_METADATA_REQUIRED", "Signed command required.");
    return res.locals.command;
  };
  router.get("/", handle((_req, res) => owner!.list(res.locals.actor)));
  router.post("/", handle((req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new DomainError(400, "PROFILE_QR_BYTES_REQUIRED", "QR bytes required.");
    return owner!.upload(res.locals.actor, meta(res), res.locals.uploadDescriptor, req.body);
  }));
  router.get("/operations/:id", handle((req, res) => owner!.status(res.locals.actor, z.uuid().parse(req.params.id))));
  router.get("/:id/file", handle((req, res) => owner!.file(res.locals.actor, z.uuid().parse(req.params.id))));
  router.patch("/:id", handle((req, res) => owner!.activate(res.locals.actor, z.uuid().parse(req.params.id), meta(res),
    z.object({ isActive: z.boolean() }).strict().parse(req.body).isActive)));
  return router;
}
