import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../contracts/actor.js';
import type { ChangeFeed } from '../infrastructure/change-feed.js';

export type StreamOwners = {
  feed: ChangeFeed;
  authorizeMessage: (actor: Actor, appointmentId: string) => Promise<void>;
  requests?: (actor: Actor) => Promise<{ requests: unknown[] }>;
};
export function streamLifetime(expiresAt: number, now = Date.now()) {
  const duration = Math.min(55_000, expiresAt * 1000 - now - 1000);
  if (!Number.isFinite(duration) || duration < 1000) throw new DomainError(401, 'SSE_AUTHORIZATION_EXPIRED', 'Fresh stream authorization required.');
  return duration;
}
export function createStreamRouter(owners?: StreamOwners) {
  const router = Router();
  const active = new Map<string, number>();
  let count = 0;
  async function stream(req: Request, res: Response, kind: 'messages' | 'requests', id?: string) {
    if (!owners) throw new DomainError(503, 'SSE_OWNER_DISABLED', 'Streaming is disabled.');
    const actor = res.locals.actor as Actor;
    if (!actor || !['doctor', 'patient'].includes(actor.role) || kind === 'requests' && actor.role !== 'doctor') throw new DomainError(403, 'SSE_ACTOR_DENIED', 'Stream is not authorized.');
    if (Object.keys(req.query).length) throw new DomainError(400, 'SSE_QUERY_DENIED', 'Unexpected stream query.');
    requireScope(actor, kind === 'messages' ? 'messaging.stream' : 'appointments.requests.read', id ?? actor.authId);
    const lifetime = streamLifetime(res.locals.assertionExpiresAt as number);
    const key = actor.authId + ':' + kind;
    if (count >= 200 || (active.get(key) ?? 0) >= 2) { res.set('Retry-After', '5'); throw new DomainError(429, 'SSE_CAPACITY_LIMIT', 'Stream capacity reached.'); }
    if (kind === 'requests' && !owners.requests) throw new DomainError(503, 'APPOINTMENT_COMPOSED_VIEW_UNAVAILABLE', 'Requests view is unavailable.');
    let closed = false, running = false, dirty = false, ready = false;
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let counted = false;
    const close = () => {
      if (closed) return;
      closed = true; unsubscribe(); clearInterval(heartbeat); clearTimeout(expiry);
      res.removeListener('close', close); req.removeListener('aborted', close);
      if (counted) { count--; const remaining = (active.get(key) ?? 1) - 1; if (remaining) active.set(key, remaining); else active.delete(key); }
      if (!res.writableEnded) res.end();
    };
    const send = (event: string, data: unknown) => {
      if (closed) return;
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (Buffer.byteLength(frame) > 1024 * 1024 || res.writableLength > 64 * 1024) { close(); return; }
      // Slow readers reconnect and recover through HTTP rather than accumulating buffers.
      if (!res.write(frame)) close();
    };
    const check = async () => {
      if (kind === 'messages') { await owners.authorizeMessage(actor, id!); return undefined; }
      return owners.requests!(actor);
    };
    const refresh = async (event: string) => {
      if (closed) return;
      if (running) { dirty = true; return; }
      running = true;
      try {
        const data = await check();
        if (Date.now() >= res.locals.assertionExpiresAt * 1000 - 1000) { close(); return; }
        send(kind === 'requests' ? 'requests' : event, data ?? {});
      } catch { close(); }
      finally { running = false; if (dirty && !closed) { dirty = false; void refresh(kind === 'messages' ? 'eligibility' : 'requests'); } }
    };
    // Reserve capacity before awaiting owner/database work, including concurrent opens.
    count++; counted = true; active.set(key, (active.get(key) ?? 0) + 1);
    res.once('close', close); req.once('aborted', close);
    try {
      unsubscribe = await owners.feed.subscribe(change => {
        if (!change) { close(); return; }
        if (kind === 'requests' && change.channel === 'vital_appointment_events' || kind === 'messages' && change.appointmentId === id) {
          if (!ready) dirty = true; else void refresh(change.kind);
        }
      });
      if (closed) { unsubscribe(); return; }
      const first = await check();
      if (closed || Date.now() >= res.locals.assertionExpiresAt * 1000 - 1000) { close(); return; }
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer' });
      res.flushHeaders();
      send(kind === 'messages' ? 'ready' : 'requests', first ?? {});
      if (closed) return;
      ready = true;
      if (dirty) { dirty = false; void refresh(kind === 'messages' ? 'eligibility' : 'requests'); }
      heartbeat = setInterval(() => { void refresh(kind === 'messages' ? 'heartbeat' : 'requests'); }, 10_000);
      expiry = setTimeout(close, Math.min(lifetime, streamLifetime(res.locals.assertionExpiresAt as number)));
    } catch (error) {
      // Preserve structured HTTP denial before streaming starts.
      if (!res.headersSent) { unsubscribe(); res.removeListener('close', close); req.removeListener('aborted', close); if (counted) { count--; const remaining = (active.get(key) ?? 1) - 1; if (remaining) active.set(key, remaining); else active.delete(key); counted = false; } throw error; }
      close();
    }
  }
  router.get('/messaging/appointments/:id/messages/stream', async (req, res) => stream(req, res, 'messages', z.uuid().parse(req.params.id)));
  router.get('/appointments/requests/stream', async (req, res) => stream(req, res, 'requests'));
  return router;
}
