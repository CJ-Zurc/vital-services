import { z } from 'zod';
import { DomainError } from '../../contracts/actor.js';
import { boundedJsonReceipt } from '../../infrastructure/http-receipt.js';
import { trustedInternalOrigin } from '../../infrastructure/private-transport.js';

export type RegistrationAuthority = (authId: string, registrationId: string, correlationId: string) => Promise<void>;
export function registrationAuthority(environment: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): RegistrationAuthority {
  return async (authId, registrationId, correlationId) => {
    const key = environment.VITAL_SERVICES_AUTH_REGISTRATION_KEY;
    let base: URL;
    try {
      base = new URL(environment.VITAL_AUTH_INTERNAL_URL ?? '');
      if (!key || key.length < 32 || base.username || base.password || base.search || base.hash || base.pathname !== '/'
        || !trustedInternalOrigin(base, environment)) throw new Error();
    } catch { throw new DomainError(503, 'REGISTRATION_AUTH_UNAVAILABLE', 'Registration authority unavailable.'); }
    try {
      const response = await fetcher(new URL('/internal/vital/registrations/resolve', base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: {
          'Content-Type': 'application/json', 'X-Internal-Service': 'vital-services',
          'X-Internal-Service-Key': key, 'X-Correlation-ID': correlationId,
        }, body: JSON.stringify({ auth_id: z.uuid().parse(authId), registration_id: z.uuid().parse(registrationId) }),
      });
      if (response.status === 409) throw new DomainError(409, 'REGISTRATION_AUTH_DENIED', 'Registration cannot be recovered.');
      if (!response.ok) throw new Error();
      const receipt = z.object({ success: z.literal(true), data: z.object({ version: z.literal(1),
        purpose: z.literal('vital.patient.self-registration'), auth_id: z.uuid(), registration_id: z.uuid(),
        email: z.string().email(), is_verified: z.boolean() }).strict() }).passthrough().parse(await boundedJsonReceipt(response));
      if (receipt.data.auth_id !== authId || receipt.data.registration_id !== registrationId) throw new Error();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, 'REGISTRATION_AUTH_UNAVAILABLE', 'Registration authority unavailable.');
    }
  };
}
