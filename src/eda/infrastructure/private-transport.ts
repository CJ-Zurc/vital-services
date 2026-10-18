/** Allow plain HTTP only to named services on the staging Docker network. */
const privateHosts = new Set([
  'auth-api:8000',
  'uhse-ehr-api:8008',
  'audit-service:8081',
  'notification-api:8000',
  'trace-backend-api:8004',
]);

export function trustedInternalOrigin(url: URL, environment: NodeJS.ProcessEnv = process.env): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:'
    && (environment.NODE_ENV !== 'production'
      || environment.VITAL_EDA_PRIVATE_HTTP === 'true' && privateHosts.has(url.host))
    && !url.username && !url.password;
}
