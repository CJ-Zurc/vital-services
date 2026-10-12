import { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import { ZodError } from "zod";
import { DomainError, type Actor } from "../contracts/actor.js";
import type { CorePrismaClient } from "../infrastructure/databases.js";
import { createProfileModule, ProfileError, type ProfileCommandGuard, type ProfileCommandMetadata } from "../modules/core/profile.js";

type ActorLocals = { actor?: Actor; command?: ProfileCommandMetadata };
type Handler = RequestHandler<Record<string, string>, unknown, unknown, Record<string, unknown>, ActorLocals>;

export function createProfileRouter(core: CorePrismaClient, options: { commandGuard?: ProfileCommandGuard } = {}): Router {
  const router = Router();
  const profile = createProfileModule(core, options.commandGuard);
  const actorRequired: Handler = (_req, res, next) => {
    if (!res.locals.actor) {
      res.status(401).json({ success: false, message: "Validated actor required." });
      return;
    }
    next();
  };
  const handle = (run: (actor: Actor, body: unknown, params: Record<string, string>, command?: ProfileCommandMetadata) => Promise<unknown>): Handler => async (req, res) => {
    const actor = res.locals.actor;
    if (!actor) throw new ProfileError(401, "Validated actor required.");
    res.json(await run(actor, req.body, req.params, res.locals.command));
  };

  router.use(actorRequired);
  router.get("/me", handle(async (actor) => ({ success: true, data: await profile.me(actor) })));
  router.post("/materialize", handle(async (actor, body, _params, command) => ({ success: true, data: await profile.materialize(actor, body ?? {}, command) })));
  router.get("/roles/:authId", handle(async (actor, _body, params) => {
    const data = await profile.roles(actor, params.authId ?? "");
    return { success: true, ...data, data };
  }));
  router.get("/patient/me", handle(async (actor) => ({ success: true, data: { vitalPatient: await profile.patientMe(actor) } })));
  router.patch("/patient/me", handle(async (actor, body, _params, command) => ({ success: true, message: "Profile updated successfully.", data: { vitalPatient: await profile.patchPatient(actor, body, command) } })));
  router.get("/doctor/me", handle(async (actor) => ({ success: true, data: { vitalDoctor: await profile.doctorMe(actor) } })));
  router.patch("/doctor/me", handle(async (actor, body, _params, command) => ({ success: true, message: "Profile updated successfully.", data: { vitalDoctor: await profile.patchDoctor(actor, body, command) } })));

  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ProfileError || error instanceof DomainError) {
      res.status(error.status).json({ success: false, message: error.message });
    } else if (error instanceof ZodError) {
      res.status(400).json({ success: false, message: "Invalid profile fields." });
    } else {
      res.status(500).json({ success: false, message: "Profile request failed." });
    }
  };
  router.use(errors);
  return router;
}
