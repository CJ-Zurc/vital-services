import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { DomainError, type Actor } from "../contracts/actor.js";
import type { createPaymentModule, PaymentMetadata, PaymentResult } from "../modules/payment/payment.js";

export type PaymentModule = ReturnType<typeof createPaymentModule> & {acknowledgment?:ReturnType<typeof import('../modules/payment/acknowledgments.js').createAcknowledgments>};
type Handler = RequestHandler<Record<string, string>, unknown, unknown, Record<string, unknown>, { actor?: Actor; command?: PaymentMetadata }>;
const empty = z.object({}).strict();
export function createPaymentRouter(payment?: PaymentModule) {
  const router = Router();
  router.use((_req, _res, next) => next(payment ? undefined : new DomainError(503, "PAYMENT_OWNER_DISABLED", "Payment extraction is disabled.")));
  const handle = (run: (actor: Actor, id: string, metadata: PaymentMetadata | undefined, body: unknown) => Promise<unknown>): Handler => async (req, res) => {
    const actor = res.locals.actor;
    if (!actor) throw new DomainError(401, "ACTOR_REQUIRED", "A verified actor is required.");
    const id = req.params.appointmentId ?? req.params.paymentId ?? actor.authId;
    z.uuid().parse(id);
    const data = await run(actor, id, res.locals.command, req.body ?? {});
    const status = typeof data === "object" && data !== null && "operationStatus" in data
      && ["pending", "unknown"].includes((data as PaymentResult).operationStatus) ? 202 : 200;
    res.status(status).json({ success: true, contractVersion: 1, data });
  };
  const mutation = (metadata: PaymentMetadata | undefined) => {
    if (!metadata) throw new DomainError(401, "COMMAND_METADATA_REQUIRED", "Signed command ID required.");
    return metadata;
  };
  router.get('/appointments/:appointmentId/acknowledgment',handle((actor,id)=>{if(!payment?.acknowledgment)throw new DomainError(503,'ACKNOWLEDGMENT_DISABLED','Unavailable.');return payment.acknowledgment(actor,id);}));
  router.get('/appointments/:appointmentId/acknowledgment/file',handle((actor,id)=>{if(!payment?.acknowledgment)throw new DomainError(503,'ACKNOWLEDGMENT_DISABLED','Unavailable.');return payment.acknowledgment(actor,id,true);}));
  router.get("/appointments/:appointmentId", handle((actor, id) => payment!.read(actor, id)));
  router.post("/appointments/:appointmentId/checkout", handle((actor, id, metadata, body) => {
    empty.parse(body); return payment!.checkout(actor, id, mutation(metadata));
  }));
  router.post("/appointments/:appointmentId/approval-checkout",handle((actor,id,metadata,body)=>{empty.parse(body);return payment!.approvalCheckout(actor,id,mutation(metadata));}));
  router.post("/appointments/:appointmentId/reconcile", handle((actor, id, metadata, body) => {
    empty.parse(body); return payment!.reconcile(actor, id, mutation(metadata));
  }));
  router.get("/admin/reviews", handle(actor => payment!.reviews(actor)));
  router.get("/admin/reviews/:paymentId", handle((actor, id) => payment!.reviewDetail(actor, id)));
  router.post("/admin/reviews/:paymentId/receipt", handle((actor, id, metadata, body) => payment!.linkReceipt(actor, id, mutation(metadata),
    z.object({ kind: z.enum(["checkout", "refund"]), providerId: z.string().regex(/^(?:cs|ref)_[A-Za-z0-9]+$/).max(128), expectedVersion: z.number().int().nonnegative() }).strict().parse(body))));
  router.post("/admin/reviews/:paymentId/refund", handle((actor, id, metadata, body) => payment!.reviewRefund(actor, id, mutation(metadata),
    z.object({ expectedVersion: z.number().int().nonnegative() }).strict().parse(body))));
  return router;
}
