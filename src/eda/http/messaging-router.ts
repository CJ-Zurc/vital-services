import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { DomainError, type Actor } from '../contracts/actor.js';
import type { AppointmentCommand } from '../modules/appointment/appointment-contracts.js';
import type { MessagingRuntime } from '../modules/messaging/runtime.js';
import { messageHoldPlaceInput, messageHoldReleaseInput } from '../modules/messaging/holds.js';
import { messageCursor } from '../modules/messaging/messages.js';

type Handler = RequestHandler<Record<string, string>, unknown, unknown, Record<string, unknown>, { actor?: Actor; command?: AppointmentCommand }>;
export function createMessagingRouter(runtime?: MessagingRuntime) {
  const router = Router();
  router.use((_req, _res, next) => next(runtime ? undefined : new DomainError(503, 'MESSAGING_OWNER_DISABLED', 'Messaging extraction is disabled.')));
  const actor = (value: Actor | undefined) => { if (!value) throw new DomainError(401, 'ACTOR_REQUIRED', 'Verified actor required.'); return value; };
  const command = (value: AppointmentCommand | undefined) => { if (!value) throw new DomainError(401, 'COMMAND_REQUIRED', 'Signed command required.'); return value; };
  const handle = (run: (req: Parameters<Handler>[0], a: Actor, meta?: AppointmentCommand) => Promise<unknown>): Handler => async (req, res) => {
    const result = await run(req, actor(res.locals.actor), res.locals.command);
    const created = typeof result === 'object' && result !== null && 'created' in result && result.created === true;
    res.status(created ? 201 : 200).json({ success: true, contractVersion: 1, data: result });
  };
  const id = (value: string | undefined) => z.uuid().parse(value);
  router.get('/conversations', handle((req, a) => runtime!.messages.conversations(a, req.query)));
  router.get('/appointments/:id/messages', handle((req, a) => runtime!.messages.history(a, id(req.params.id), req.query)));
  router.post('/appointments/:id/messages', handle((req, a, meta) => runtime!.messages.send(a, id(req.params.id), command(meta), req.body)));
  router.patch('/appointments/:id/messages/read', handle((req, a, meta) => runtime!.messages.read(a, id(req.params.id), command(meta), req.body)));
  router.use('/admin', (_req, _res, next) => next(runtime?.holds ? undefined : new DomainError(503, 'MESSAGE_HOLDS_DISABLED', 'Message holds are disabled.')));
  router.get('/admin/conversations', handle(async (req, a) => {
    const query = z.object({ before: z.string().optional(), appointmentId: z.uuid().optional(), conversationId: z.uuid().optional(), hold: z.enum(['all', 'held', 'unheld']).optional() }).strict().parse(req.query);
    const before = messageCursor(query.before);
    const page = await runtime!.holds!.list(a, { appointmentId: query.appointmentId, conversationId: query.conversationId,
      holdState: query.hold ?? 'all', ...(before ? { before: { createdAt: before.at.toISOString(), id: before.id } } : {}) });
    return { ...page, nextCursor: page.nextCursor ? Buffer.from(JSON.stringify({ at: page.nextCursor.createdAt, id: page.nextCursor.id })).toString('base64url') : null };
  }));
  router.post('/admin/conversations/:id/hold', handle((req, a, meta) => runtime!.holds!.place(a, id(req.params.id), command(meta), messageHoldPlaceInput.parse(req.body))));
  router.delete('/admin/conversations/:id/hold', handle((req, a, meta) => runtime!.holds!.release(a, id(req.params.id), command(meta), messageHoldReleaseInput.parse(req.body))));
  return router;
}
