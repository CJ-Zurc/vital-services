import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { authorizePortalIntegration } from '../modules/portal-integrations/portal-integrations-contracts.js';
import { DomainError, type Actor } from '../contracts/actor.js';
import type { PortalIntegrations } from '../modules/portal-integrations/portal-integrations.js';
import { verifyActorAssertion } from '../infrastructure/security.js';

export function verifyPortalIntegrationAssertion(input: Parameters<typeof verifyActorAssertion>[0]) {
  const actor = verifyActorAssertion(input);
  return { actor, source: portalIntegrationDelegation(input.token, actor, input.method, input.path) };
}

// Call only with a token already verified by the existing process-mTLS/asymmetric assertion middleware.
// Returns the independently allowlisted signed source claims; no caller-controlled HTTP header is authority here.
export function portalIntegrationDelegation(verifiedToken: string, actor: Actor, method: string, path: string) {
  const claims = jwt.decode(verifiedToken);
  if (!claims || typeof claims === 'string') throw new DomainError(403, 'PORTAL_INTEGRATION_DELEGATION_DENIED', 'Signed source authority required.');
  const result = authorizePortalIntegration(actor, claims.portalDelegation, method, path);
  if (!Number.isInteger(claims.exp) || claims.exp! > result.source.expiresAt)
    throw new DomainError(403, 'PORTAL_INTEGRATION_DELEGATION_DENIED', 'Source authorization cannot be extended.');
  return result.source;
}
export function createPortalIntegrationsRouter(owner?: PortalIntegrations) {
  const router = Router();
  for (const route of ['doctors', 'patients', 'appointments', 'patient/appointments', 'patient/bootstrap',
    'doctors/workflows', 'doctors/workflows/:workflowId', 'doctors/workflows/:workflowId/commit']) {
    const handler: import('express').RequestHandler = async (req, res) => {
      if (!res.locals.actor || !res.locals.portalDelegation) throw new DomainError(403, 'PORTAL_INTEGRATION_DELEGATION_DENIED', 'Verified portal delegation required.');
      if (!owner) throw new DomainError(503, 'PORTAL_INTEGRATION_OWNER_DISABLED', 'Portal owner disabled.');
      const data = await owner.execute(res.locals.actor, res.locals.portalDelegation, req.method, req.originalUrl, req.query, req.body, res.locals.command);
      res.json({ success: true, contractVersion: 1, data });
    };
    if (route === 'patient/bootstrap' || route === 'doctors/workflows' || route.endsWith('/commit')) router.post('/' + route, handler);
    else router.get('/' + route, handler);
  }
  return router;
}
