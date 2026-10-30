import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor } from '../contracts/actor.js';
import { DomainError } from '../contracts/actor.js';
import { requestHash } from './security.js';

export const readPageInput = { limit: z.coerce.number().int().min(1).max(50).default(10), cursor: z.string().max(4096).optional() };
const position = z.array(z.string().max(256).nullable()).max(5);
const cursorSchema = z.object({ version: z.literal(1), subject: z.string().max(96), collection: z.string().max(160),
  filters: z.string().regex(/^[a-f0-9]{64}$/), snapshot: z.string().regex(/^[a-f0-9]{64}$/), at: z.number().int().nonnegative(), after: position.nullable() }).strict();
export interface ReadPageMeta { nextCursor: string | null; validationCursor: string; snapshot: string; total: number; asOf: string }
export interface ReadPage<T> { items: T[]; meta: ReadPageMeta }
export async function collectReadPages<T extends { id: string }>(read: (query: { limit: number; cursor?: string }) => Promise<ReadPage<T>>, maxBytes = 16 * 1024 * 1024) {
  const items: T[] = [], ids = new Set<string>(), cursors = new Set<string>(), deadline = Date.now() + 30_000;
  let cursor: string | undefined, snapshot: string | undefined, bytes = 0, total: number | undefined, asOf: string | undefined, validationCursor: string | undefined;
  do {
    if (Date.now() >= deadline) throw new DomainError(504,'APPOINTMENT_READ_BUDGET_EXCEEDED','Read composition deadline exceeded.');
    const page = await read({ limit:10,...(cursor ? { cursor } : {}) });
    if (Date.now() >= deadline) throw new DomainError(504,'APPOINTMENT_READ_BUDGET_EXCEEDED','Read composition deadline exceeded.');
    if (snapshot && (snapshot !== page.meta.snapshot || total !== page.meta.total || asOf !== page.meta.asOf))
      throw new DomainError(409,'APPOINTMENT_READ_SNAPSHOT_CHANGED','Read snapshot changed.');
    snapshot = page.meta.snapshot;total = page.meta.total;asOf = page.meta.asOf;validationCursor = page.meta.validationCursor;
    for (const item of page.items) {
      if (ids.has(item.id)) throw new DomainError(409,'APPOINTMENT_READ_SNAPSHOT_CHANGED','Duplicate read item.');
      ids.add(item.id); bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > maxBytes) throw new DomainError(503,'APPOINTMENT_READ_BUDGET_EXCEEDED','Read response budget exceeded.');
      items.push(item);
    }
    cursor = page.meta.nextCursor ?? undefined;
    if (cursor) { if (cursors.has(cursor)) throw new DomainError(409,'APPOINTMENT_READ_SNAPSHOT_CHANGED','Read cursor did not advance.'); cursors.add(cursor); }
  } while (cursor);
  if (items.length !== total || !validationCursor) throw changed();
  const verified = await read({limit:1,cursor:validationCursor});
  if (Date.now() >= deadline) throw new DomainError(504,'APPOINTMENT_READ_BUDGET_EXCEEDED','Read composition deadline exceeded.');
  if (verified.meta.snapshot !== snapshot || verified.meta.total !== total || verified.meta.asOf !== asOf) throw changed();
  return items;
}
export interface ReadOrder { key: string; direction: 'ASC' | 'DESC'; cast: 'text' | 'timestamp' | 'date' | 'time' }
export function prepareReadPage(actor: Actor, collection: string, filters: unknown, input: { limit: number; cursor?: string }, clock = Date.now) {
  input = z.object(readPageInput).strict().parse({limit:input.limit,...(input.cursor === undefined ? {} : {cursor:input.cursor})});
  const subject = actor.authId + ':' + actor.role;
  const filterHash = requestHash('READ', collection, filters);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (input.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
    catch { throw new DomainError(400, 'APPOINTMENT_READ_CURSOR_INVALID', 'Invalid read cursor.'); }
    if (cursor.subject !== subject || cursor.collection !== collection || cursor.filters !== filterHash
      || cursor.at > clock() + 1000 || clock() - cursor.at > 30_000)
      throw new DomainError(400, 'APPOINTMENT_READ_CURSOR_INVALID', 'Invalid read cursor.');
  }
  return { subject, collection, filters: filterHash, limit: input.limit, at: cursor?.at ?? clock(), cursor };
}
type PreparedPage = ReturnType<typeof prepareReadPage>;
const changed = () => new DomainError(409, 'APPOINTMENT_READ_SNAPSHOT_CHANGED', 'Read snapshot changed. Restart the read.');
export async function readCollectionPage<T extends { id: string }>(pool: Pool, page: PreparedPage,
  specification: { sql: string; values: unknown[]; order: ReadOrder[] }): Promise<ReadPage<T>> {
  const { sql, values, order } = specification;
  // Identifiers/casts come exclusively from owner-owned specifications, never request data.
  if (!order.length || order.length > 5 || order.some(field => !/^[A-Za-z][A-Za-z0-9]*$/.test(field.key)
    || !['ASC', 'DESC'].includes(field.direction) || !['text', 'timestamp', 'date', 'time'].includes(field.cast))) throw new Error('INVALID_READ_SPECIFICATION');
  const after = page.cursor?.after;
  if (after && after.length !== order.length) throw new DomainError(400, 'APPOINTMENT_READ_CURSOR_INVALID', 'Invalid read cursor.');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const current = (await tx.query<{ revision: string; total: string }>(`SELECT
      md5(COALESCE(string_agg(md5(row_to_json(r)::text),',' ORDER BY r.id),'')) AS revision,COUNT(*)::text AS total
      FROM (${sql}) r`, values)).rows[0]!;
    const snapshot = createHash('sha256').update(JSON.stringify([page.subject, page.collection, page.filters, page.at, current.revision])).digest('hex');
    if (page.cursor && snapshot !== page.cursor.snapshot) throw changed();
    const parameters = [...values];
    let seek = '';
    if (after) {
      const bindings = order.map((field, index) => { parameters.push(after[index]); return '$' + parameters.length + '::' + field.cast; });
      seek = 'WHERE (' + order.map((field, index) => {
        const prefix = order.slice(0, index).map((earlier, j) => `r."${earlier.key}"::${earlier.cast} IS NOT DISTINCT FROM ${bindings[j]}`);
        const advance = after[index] === null ? 'FALSE' : `(r."${field.key}"::${field.cast} ${field.direction === 'ASC' ? '>' : '<'} ${bindings[index]} OR r."${field.key}" IS NULL)`;
        return '(' + [...prefix, advance].join(' AND ') + ')';
      }).join(' OR ') + ')';
    }
    parameters.push(page.limit + 1);
    const selected = (await tx.query<T>(`SELECT r.* FROM (${sql}) r ${seek}
      ORDER BY ${order.map(field => `r."${field.key}"::${field.cast} ${field.direction} NULLS LAST`).join(',')}
      LIMIT $${parameters.length}`, parameters)).rows;
    const items = selected.slice(0, page.limit), last = items.at(-1) as (T & Record<string, unknown>) | undefined;
    const total = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(current.total);
    const encode = (after: (string|null)[] | null) => Buffer.from(JSON.stringify({ version:1,subject:page.subject,collection:page.collection,
      filters:page.filters,snapshot,at:page.at,after })).toString('base64url');
    const nextCursor = selected.length > page.limit && last ? encode(order.map(field => {
      const value=last[field.key];return value==null?null:value instanceof Date?value.toISOString():String(value);
    })) : null;
    await tx.query('COMMIT');
    return { items, meta: { snapshot, total, asOf: new Date(page.at).toISOString(), nextCursor,validationCursor:encode(null) } };
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
