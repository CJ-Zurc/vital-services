import { Router, type RequestHandler } from 'express';
import { DomainError, type Actor } from '../contracts/actor.js';
import type { CompletionReads } from '../modules/composition/completion-reads.js';
import type { ExportQuery } from '../contracts/completion.js';

export function parseCompletionExportQuery(query: URLSearchParams): ExportQuery {
  const requested = Number(query.get('limit') ?? '200');
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 500) : 200;
  let cursor: ExportQuery['cursor'] = null;
  const raw = query.get('cursor');
  if (raw) {
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (!parsed.updatedAt || typeof parsed.updatedAt !== 'string' || !parsed.id || typeof parsed.id !== 'string'
        || Number.isNaN(new Date(parsed.updatedAt).getTime()) || raw.length > 8192) throw new Error();
      cursor = { updatedAt: parsed.updatedAt, id: parsed.id };
    } catch { throw new DomainError(422, 'COMPLETION_ANALYTICS_CURSOR_INVALID', 'Invalid analytics cursor.'); }
  }
  const upperBound = query.get('upperBound');
  if (upperBound && Number.isNaN(new Date(upperBound).getTime()))
    throw new DomainError(422, 'COMPLETION_ANALYTICS_BOUND_INVALID', 'Invalid upperBound.');
  return { limit, cursor, upperBound: upperBound || null };
}

export function createCompletionRouter(reads?: CompletionReads) {
  const router = Router();
  type Handler = RequestHandler<Record<string, string>, unknown, unknown, Record<string, unknown>, { actor?: Actor; command?: { operationId: string; requestHash: string } }>;
  const handle = (run: (actor: Actor, req: Parameters<Handler>[0], command?: { operationId: string; requestHash: string }) => Promise<unknown>, status = 200): Handler => async (req, res) => {
    if (!reads) throw new DomainError(503, 'COMPLETION_OWNER_DISABLED', 'Completion extraction is disabled.');
    const actor = res.locals.actor;
    if (!actor) throw new DomainError(401, 'ACTOR_REQUIRED', 'Verified actor required.');
    if (req.method === 'POST' && !res.locals.command?.operationId) throw new DomainError(401, 'COMMAND_METADATA_REQUIRED', 'Signed command ID required.');
    const data = await run(actor, req, res.locals.command);
    res.status(status).json({ success: true, contractVersion: 1, data });
  };
  router.get('/patient/dashboard', handle(actor => reads!.patientDashboard(actor)));
  router.get('/admin/dashboard', handle(actor => reads!.adminDashboard(actor)));
  router.get('/consents', handle((actor, req) => {
    const query = new URL(req.originalUrl, 'https://internal.invalid').searchParams;
    if ([...query.keys()].some(key => !['patientId','limit','cursor'].includes(key) || query.getAll(key).length !== 1))
      throw new DomainError(400, 'COMPLETION_CONSENT_QUERY_INVALID', 'Invalid consent query.');
    return reads!.consents(actor, Object.fromEntries(query));
  }));
  router.post('/consents', handle((actor, req, command) => reads!.acceptConsent(actor, req.body, command), 201));
  router.get('/analytics/pre-consultations', handle((actor, req) => reads!.exportSubmitted(actor,
    parseCompletionExportQuery(new URL(req.originalUrl, 'https://internal.invalid').searchParams))));
  return router;
}
