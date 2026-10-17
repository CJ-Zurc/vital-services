import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { createChangeFeed, type Change } from '../src/eda/infrastructure/change-feed.js';
import { runtimeHealth, validHealth } from '../src/eda/infrastructure/runtime-health.js';
import { createStreamRouter, streamLifetime, type StreamOwners } from '../src/eda/http/stream-router.js';

test('EDA SSE lifetime never extends assertion expiry or clock tolerance', () => {
  assert.equal(streamLifetime(1030, 1_000_000), 29_000);
  assert.equal(streamLifetime(1100, 1_000_000), 55_000);
  for (const expiry of [1000, 1001, NaN, undefined]) assert.throws(() => streamLifetime(expiry as number, 1_000_000));
});

test('EDA SSE feed shares one LISTEN connection and filters content-free hints', async () => {
  const client = Object.assign(new EventEmitter(), { query: async () => ({}), release: () => {} });
  let connections = 0;
  const feed = createChangeFeed({ connect: async () => { connections++; return client; } } as unknown as Pool);
  const seen: unknown[] = [];
  const [one, two] = await Promise.all([feed.subscribe(value => seen.push(value)), feed.subscribe(value => seen.push(value))]);
  assert.equal(connections, 1);
  client.emit('notification', { channel: 'vital_message_events', payload: JSON.stringify({ appointmentId: randomUUID(), kind: 'message', content: 'must reject' }) });
  client.emit('notification', { channel: 'other', payload: '{}' });
  assert.equal(seen.length, 0);
  client.emit('notification', { channel: 'vital_message_events', payload: JSON.stringify({ appointmentId: randomUUID(), kind: 'message' }) });
  assert.equal(seen.length, 2);
  one(); two(); feed.close();
});

test('EDA SSE listener gaps invalidate streams and next subscriber reconnects', async () => {
  const clients: EventEmitter[] = [];
  const feed = createChangeFeed({ connect: async () => { const value = Object.assign(new EventEmitter(), { query: async () => ({}), release: () => {} }); clients.push(value); return value; } } as unknown as Pool);
  let gaps = 0;
  const off = await feed.subscribe(value => { if (!value) gaps++; });
  clients[0]!.emit('error', new Error('transport details are private'));
  assert.equal(gaps, 1); off();
  const next = await feed.subscribe(() => {});
  assert.equal(clients.length, 2); next(); feed.close();
});

function fixture() {
  const id = randomUUID(), authId = randomUUID();
  let callback: ((value: Change | null) => void) | undefined, unsubscribed = 0, checks = 0;
  const owners: StreamOwners = { feed: { subscribe: async cb => { callback = cb; return () => { unsubscribed++; }; }, close() {} },
    authorizeMessage: async () => { checks++; } };
  const req = Object.assign(new EventEmitter(), { query: {}, params: { id } });
  const frames: string[] = [];
  const res = Object.assign(new EventEmitter(), { locals: { actor: { authId, role: 'patient', serviceId: 'vital-web', scopes: ['messaging.stream'], resource: id }, assertionExpiresAt: Math.floor(Date.now() / 1000) + 30 },
    writableEnded: false, writableLength: 0, headersSent: false, status() { return this; }, set() { return this; },
    flushHeaders() { this.headersSent = true; }, write(frame: string): boolean { frames.push(frame); return true; }, end() { this.writableEnded = true; } });
  const router = createStreamRouter(owners);
  const route = router.stack.find(layer => layer.route?.path === '/messaging/appointments/:id/messages/stream')!;
  const open = () => Promise.resolve(route.route!.stack[0]!.handle(req as never, res as never, (() => {}) as never));
  return { open, req, res, frames, emit: (value: Change | null) => callback?.(value), checks: () => checks, unsubscribed: () => unsubscribed, id };
}
test('EDA SSE authorizes before ready rechecks hints and cleans listeners on disconnect', async () => {
  const f = fixture(); await f.open();
  assert.equal(f.checks(), 1); assert.match(f.frames[0]!, /^event: ready\ndata: \{\}/);
  f.emit({ channel: 'vital_message_events', appointmentId: f.id, kind: 'message' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.checks(), 2); assert.match(f.frames[1]!, /^event: message/);
  f.res.emit('close'); assert.equal(f.unsubscribed(), 1);
  assert.equal(f.req.listenerCount('aborted'), 0);
});
test('EDA SSE wrong resource role and query are denied before subscription', async () => {
  for (const field of ['resource', 'role', 'query']) {
    const f = fixture();
    if (field === 'query') f.req.query = { unexpected: 'denied' };
    else if (field === 'resource') f.res.locals.actor.resource = randomUUID();
    else f.res.locals.actor.role = 'admin';
    await assert.rejects(f.open()); assert.equal(f.checks(), 0); assert.equal(f.frames.length, 0);
  }
});
test('EDA SSE feed gap and slow readers close instead of retaining unbounded work', async () => {
  const gap = fixture(); await gap.open(); gap.emit(null); assert.equal(gap.res.writableEnded, true);
  const slow = fixture(); slow.res.write = () => false; await slow.open();
  assert.equal(slow.res.writableEnded, true); slow.res.emit('close');
});
test('EDA runtime health requires current progress and restricted non-secret heartbeat files', () => {
  assert.equal(validHealth({ ready: true, pid: 1, at: 1000 }, 2000), true);
  for (const row of [{ ready: false, pid: 1, at: 1000 }, { ready: true, pid: 0, at: 1000 },
    { ready: true, pid: 1, at: 1000, token: 'never accepted' }, { ready: true, pid: 1, at: 200000 }]) assert.equal(validHealth(row, 2000), false);
  assert.equal(validHealth({ ready: true, pid: 1, at: 1000 }, 122000), false);
  const inactive = runtimeHealth('worker', {}); inactive.ready(); inactive.unavailable();
  assert.throws(() => runtimeHealth('worker', { VITAL_EDA_WORKER_HEALTH_FILE: '/etc/unsafe' }), /PATH_INVALID/);
});
