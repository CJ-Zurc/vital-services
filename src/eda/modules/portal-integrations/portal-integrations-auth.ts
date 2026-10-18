import { z } from 'zod';
import { boundedJsonReceipt } from '../../infrastructure/http-receipt.js';
import { trustedInternalOrigin } from '../../infrastructure/private-transport.js';
import type { PortalIdentityLookup } from './portal-integrations-profile.js';

export function createPortalIdentityLookup(config: { baseUrl: string; key: string }, fetcher: typeof fetch = fetch): PortalIdentityLookup {
  const base = new URL(config.baseUrl);
  if (!config.key || base.username || base.password || !trustedInternalOrigin(base)) throw new Error('PORTAL_AUTH_CONFIGURATION_INVALID');
  const identity = z.object({ id: z.uuid(), first_name: z.string(), middle_name: z.string().nullable(),
    last_name: z.string(), extension_name: z.string().nullable(), email: z.string().nullable() }).passthrough();
  return async ids => {
    if (ids.length > 200 || ids.some(id => !z.uuid().safeParse(id).success)) throw new Error('PORTAL_AUTH_BATCH_INVALID');
    const result = new Map<string, { name: string | null; email: string | null }>();
    const pending = [...new Set(ids)], signal = AbortSignal.timeout(6000);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (index < pending.length && !signal.aborted) {
        const authId = pending[index++]!;
        try {
          const response = await fetcher(new URL('/internal/users/' + authId + '/profile', base), {
            method: 'GET', redirect: 'error', signal,
            headers: { 'X-Internal-Service': 'vital-services', 'X-Internal-Service-Key': config.key } });
          if (!response.ok) { await response.body?.cancel(); continue; }
          const value = z.object({ success: z.literal(true), data: identity }).passthrough().parse(await boundedJsonReceipt(response));
          if (value.data.id !== authId) continue;
          const name = [value.data.first_name, value.data.middle_name, value.data.last_name, value.data.extension_name]
            .map(part => part?.trim()).filter(Boolean).join(' ') || null;
          result.set(authId, { name, email: value.data.email });
        } catch { /* Legacy enrichment is best-effort; identity absence never grants authority. */ }
      }
    }));
    return result;
  };
}
