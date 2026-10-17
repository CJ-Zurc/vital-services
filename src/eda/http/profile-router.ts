import { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import { z, ZodError } from "zod";
import { DomainError, type Actor } from "../contracts/actor.js";
import type { CorePrismaClient } from "../infrastructure/databases.js";
import { createProfileModule, ProfileError, type ProfileCommandGuard, type ProfileCommandMetadata } from "../modules/profile/profile.js";
import type { ProfileSyncStatuses, ProfileSyncStatus } from "../modules/profile/profile-contracts.js";
import { registrationAuthority, type RegistrationAuthority } from '../modules/profile/registration-authority.js';

type ActorLocals = { actor?: Actor; command?: ProfileCommandMetadata };
type Handler = RequestHandler<Record<string, string>, unknown, unknown, Record<string, unknown>, ActorLocals>;

export function createProfileRouter(core: CorePrismaClient, options: { commandGuard?: ProfileCommandGuard; syncStatuses?: ProfileSyncStatuses; registrationAuthority?: RegistrationAuthority } = {}): Router {
  const router = Router();
  const profile = createProfileModule(core, options.commandGuard, options.registrationAuthority ?? registrationAuthority());
  async function statuses(authIds: string[]) {
    try { return await options.syncStatuses?.(authIds) ?? new Map<string, ProfileSyncStatus>(); }
    catch { return new Map<string, ProfileSyncStatus>(); }
  }
  async function syncResult(result: unknown) {
    if (!result || typeof result !== "object" || !("authId" in result) || typeof result.authId !== "string") return result;
    const current = await statuses([result.authId]);
    return { ...result, syncStatus: current.get(result.authId) ?? "pending" };
  }
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
  router.post("/registration/bootstrap", handle(async (actor, body, _params, command) => {
    if (actor.role !== 'patient') throw new ProfileError(403, 'Registration delegation denied.');
    return { success: true, data: await profile.bootstrapRegistration(actor, body, command) };
  }));
  router.post('/registration/receipt', handle(async (actor, body, _params, command) => {
    if (actor.role !== 'service') throw new ProfileError(403, 'Registration delegation denied.');
    return { success: true, data: await profile.bootstrapRegistration(actor, body, command) };
  }));
  router.get("/roles/:authId", handle(async (actor, _body, params) => {
    const data = await profile.roles(actor, params.authId ?? "");
    return { success: true, ...data, data };
  }));
  router.get("/patient/me", handle(async (actor) => ({ success: true, data: { vitalPatient: await profile.patientMe(actor) } })));
  router.post("/patient/ehr-record-notice", handle(async (actor, body, _params, command) => ({ success: true, data: await profile.dismissPatientNotice(actor, body ?? {}, command) })));
  router.patch("/patient/me", handle(async (actor, body, _params, command) => ({ success: true, message: "Profile updated successfully.", data: { vitalPatient: await profile.patchPatient(actor, body, command) } })));
  router.get("/doctor/me", handle(async (actor) => ({ success: true, data: { vitalDoctor: await profile.doctorMe(actor) } })));
  router.patch("/doctor/me", handle(async (actor, body, _params, command) => ({ success: true, message: "Profile updated successfully.", data: { vitalDoctor: await profile.patchDoctor(actor, body, command) } })));
  router.post("/workflows", handle(async (actor, body, _params, command) => ({ success: true, data: await profile.workflows.prepare(actor, body, command) })));
  router.get("/workflows/:id", handle(async (actor, _body, params) => ({ success: true, data: await profile.workflows.status(actor, params.id ?? "") })));
  router.post("/workflows/:id/commit", handle(async (actor, body, params, command) => {
    const result = await profile.workflows.commit(actor, params.id ?? "", body, command);
    return { success: true, data: { ...result, data: result.kind === "patient.onboarding" ? result.data : await syncResult(result.data) } };
  }));
  router.get("/admin/doctors", handle(async (actor) => {
    const result = await profile.adminDoctors(actor);
    const current = await statuses(result.items.map((item) => item.authId));
    return { success: true, data: { ...result, items: result.items.map((item) => ({ ...item, syncStatus: current.get(item.authId) ?? "pending" })) } };
  }));
  router.get("/admin/membership", handle(async (actor) => ({ success: true, data: await profile.adminMembership(actor) })));
  const adminCommitSchema = z.object({ workflowId: z.uuid(), input: z.unknown(), receipt: z.unknown() }).strict();
  router.post("/admin/doctors", handle(async (actor, body, _params, command) => {
    const { workflowId, ...input } = adminCommitSchema.parse(body);
    const result = await profile.workflows.commit(actor, workflowId, input, command, "doctor.provision");
    return { success: true, data: { doctor: await syncResult(result.data) } };
  }));
  router.patch("/admin/doctors", handle(async (actor, body, _params, command) => {
    const { workflowId, ...input } = adminCommitSchema.parse(body);
    const result = await profile.workflows.commit(actor, workflowId, input, command, "doctor.specialty");
    return { success: true, data: { doctor: await syncResult(result.data) } };
  }));

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
