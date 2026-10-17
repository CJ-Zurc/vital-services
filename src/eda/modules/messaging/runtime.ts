import type { Pool } from 'pg';
import { createMessagingModule } from './messages.js';
import { createMessageCrypto } from './crypto.js';
import { createMessageHolds } from './holds.js';
import { createMessagingRetention } from './retention.js';

export function messagingRuntime(databases: { corePool: Pool }, environment: NodeJS.ProcessEnv = process.env) {
  const enabled = environment.VITAL_EDA_MESSAGING_ENABLED === 'true';
  const holds = environment.VITAL_EDA_MESSAGE_HOLDS_ENABLED === 'true';
  const scan = environment.VITAL_EDA_MESSAGING_RETENTION_SCAN_ENABLED === 'true';
  const purge = environment.VITAL_EDA_MESSAGING_RETENTION_ENABLED === 'true';
  if (!enabled) {
    if (holds || scan || purge) throw new Error('MESSAGING_DEPENDENCY_FLAGS_INVALID');
    return undefined;
  }
  if (environment.VITAL_EDA_ENABLED !== 'true' || environment.VITAL_EDA_APPOINTMENT_ENABLED !== 'true') throw new Error('MESSAGING_APPOINTMENT_OWNER_REQUIRED');
  if (purge && !scan) throw new Error('MESSAGING_PURGE_WITHOUT_SCAN');
  createMessageCrypto(environment).assertConfigured();
  const retention = createMessagingRetention(databases.corePool, environment);
  return { messages: createMessagingModule(databases.corePool, environment), holds: holds ? createMessageHolds(databases.corePool, environment) : undefined,
    async retentionTick(signal?: AbortSignal) { if (scan) return retention.tick(signal); return undefined; } };
}
export type MessagingRuntime = NonNullable<ReturnType<typeof messagingRuntime>>;
