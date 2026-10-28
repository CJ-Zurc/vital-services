import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeDelivery, observeRequest, observeDeliveryOutcome } from '../src/eda/infrastructure/observation.js';
import { deliverPending } from '../src/eda/modules/platform-delivery/delivery.js';

test('delivery observation emits explicit zeros without leaking stored payloads', async () => {
  const lines: string[] = [];
  const previous = console.log;
  console.log = value => { lines.push(String(value)); };
  try {
    await observeDelivery({ query: async () => ({ rows: [{ destination: 'audit', status: 'blocked', count: 2, oldest_age_seconds: 70, payload: 'secret' }] }) } as never);
  } finally { console.log = previous; }
  assert.equal(lines.length, 6);
  assert.equal(JSON.parse(lines[0]).count, 0);
  assert.equal(JSON.parse(lines[2]).count, 2);
  assert.ok(!lines.join('').includes('secret'));
});


test('private API observation records headers once and excludes request bodies and query strings', () => {
  const lines: string[] = [];
  const previous = console.log;
  console.log = value => { lines.push(String(value)); };
  try {
    const req = { method: 'GET', baseUrl: '/internal/v1/profile', route: { path: '/:id' }, body: { secret: 'private' }, originalUrl: '/x?secret=private' };
    const res = { locals: { actor: { correlationId: 'verified-id' } }, writeHead: () => res };
    let continued = false;
    observeRequest(req as never, res as never, () => { continued = true; });
    assert.ok(continued);
    (res.writeHead as Function)(200);
    (res.writeHead as Function)(200);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).route, '/internal/v1/profile/:id');
    assert.equal(JSON.parse(lines[0]).duration_kind, 'response_headers');
    assert.ok(!lines[0].includes('private'));
  } finally { console.log = previous; }
});


test('delivery outcome observation contains only destination and delivery state', () => {
  const previous = console.log;
  const lines: string[] = [];
  console.log = value => { lines.push(String(value)); };
  try { observeDeliveryOutcome('audit', 'blocked'); }
  finally { console.log = previous; }
  assert.deepEqual(JSON.parse(lines[0]), { event_type: 'delivery_outcome', destination: 'audit', status: 'blocked' });
});

test('delivery failure observation identifies HTTP rejection without content', async () => {
  const previous = console.log; const lines: string[] = [];
  console.log = value => { lines.push(String(value)); };
  let queries = 0;
  const pool = { query: async () => ++queries === 1 ? { rows: [{ id: 'private-id', destination: 'audit',
    correlationId: 'private-correlation', payload: { sensitive: 'private-content' }, attempts: 0 }] } : { rows: [], rowCount: 1 } };
  try {
    await deliverPending(pool as never, { audit: { baseUrl: 'https://example.invalid', key: 'private-key' },
      notification: { baseUrl: 'https://example.invalid', key: 'private-key' } },
    (async () => new Response('private-response', { status: 422 })) as typeof fetch);
  } finally { console.log = previous; }
  assert.deepEqual(JSON.parse(lines[0]), { event_type: 'delivery_outcome', destination: 'audit',
    status: 'retry_pending', failure_reason: 'http_rejected', http_status: 422 });
  assert.ok(!lines[0].includes('private'));
});
