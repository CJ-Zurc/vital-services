import type { Pool, PoolClient, Notification } from 'pg';
import { z } from 'zod';

export type Change = { channel: 'vital_message_events' | 'vital_appointment_events'; appointmentId: string; kind: 'message' | 'read' | 'eligibility' };
const payload = z.object({ appointmentId: z.uuid(), kind: z.enum(['message', 'read', 'eligibility']) }).strict();

/** One LISTEN connection per API, never one connection per browser. */
export function createChangeFeed(pool: Pick<Pool, 'connect'>) {
  const subscribers = new Set<(change: Change | null) => void>();
  let client: PoolClient | undefined;
  let connecting: Promise<void> | undefined;
  let closed = false;
  const notify = (event: Notification) => {
    if (!['vital_message_events', 'vital_appointment_events'].includes(event.channel) || !event.payload || event.payload.length > 256) return;
    try {
      const parsed = payload.safeParse(JSON.parse(event.payload));
      if (parsed.success) for (const callback of subscribers) callback({ channel: event.channel as Change['channel'], ...parsed.data });
    } catch { /* Durable HTTP state, not notifications, is authoritative. */ }
  };
  const disconnect = () => {
    const previous = client; client = undefined;
    if (previous) {
      previous.removeListener('notification', notify);
      previous.removeListener('error', disconnect);
      previous.removeListener('end', disconnect);
      previous.release(true);
    }
    // Force a freshly authorized reconnect and full state recovery after a gap.
    for (const callback of [...subscribers]) callback(null);
  };
  async function connect() {
    if (closed) throw new Error('SSE_FEED_CLOSED');
    if (connecting) return connecting;
    if (client) return;
    if (!connecting) connecting = (async () => {
      const next = await pool.connect();
      if (closed) { next.release(); throw new Error('SSE_FEED_CLOSED'); }
      client = next;
      next.on('error', disconnect); next.on('end', disconnect); next.on('notification', notify);
      try { await next.query('LISTEN vital_message_events'); await next.query('LISTEN vital_appointment_events'); }
      catch (error) { disconnect(); throw error; }
    })().finally(() => { connecting = undefined; });
    return connecting;
  }
  return {
    async subscribe(callback: (change: Change | null) => void) {
      subscribers.add(callback);
      try { await connect(); } catch (error) { subscribers.delete(callback); throw error; }
      return () => { subscribers.delete(callback); };
    },
    close() { closed = true; disconnect(); subscribers.clear(); },
  };
}
export type ChangeFeed = ReturnType<typeof createChangeFeed>;
