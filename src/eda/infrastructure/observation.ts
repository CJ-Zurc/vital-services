import type { RequestHandler, Response } from 'express';
import type { Pool } from 'pg';

function emit(record: Record<string, unknown>) {
  try { console.log(JSON.stringify(record)); } catch { /* Telemetry never changes domain outcomes. */ }
}

export function observeDeliveryOutcome(destination: 'audit' | 'notification', status: 'accepted' | 'retry_pending' | 'blocked') {
  emit({ event_type: 'delivery_outcome', destination, status });
}

/** No URLs, query strings, bodies, or caller-supplied identity enter telemetry. */
export const observeRequest: RequestHandler = (req, res, next) => {
  const started = performance.now();
  const original = res.writeHead;
  let emitted = false;
  res.writeHead = function (this: Response, ...args: Parameters<typeof original>) {
    if (!emitted) {
      emitted = true;
      const route = typeof req.route?.path === 'string' ? req.baseUrl.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id') + req.route.path : 'unmatched';
      emit({ event_type: 'api_request', plane: 'system',
        method: req.method, route, status_code: args[0],
        duration_ms: Math.round(performance.now() - started), duration_kind: 'response_headers',
        correlation_id: res.locals.actor?.correlationId ?? null });
    }
    return original.apply(this, args);
  } as typeof original;
  next();
};

export async function observeDelivery(pool: Pick<Pool, 'query'>) {
  try {
    const result = await pool.query(`SELECT destination,status,count(*)::int AS count,
      COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN("createdAt"))),0)::float AS oldest_age_seconds
      FROM integration_deliveries WHERE destination IN ('audit','notification')
      AND status IN ('pending','processing','blocked') GROUP BY destination,status`);
    for (const destination of ['audit', 'notification']) {
      for (const status of ['pending', 'processing', 'blocked']) {
        const row = result.rows.find(row => row.destination === destination && row.status === status);
        emit({ event_type: 'delivery_snapshot', destination, status,
          count: Number(row?.count ?? 0), oldest_age_seconds: Number(row?.oldest_age_seconds ?? 0) });
      }
    }
  } catch {
    emit({ level: 'error', event_type: 'delivery_snapshot_unavailable' });
  }
}
