import { readFileSync } from "node:fs";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient as CorePrismaClient } from "../generated/core/client.js";
import { PrismaClient as IntegrationsPrismaClient } from "../generated/integrations/client.js";
import { utcPgTypes,configureUtcDateParameters } from "./utc-types.js";

export { CorePrismaClient, IntegrationsPrismaClient };

export function validateDatabaseBoundary(coreUrl: string, integrationsUrl: string) {
  const core = new URL(coreUrl);
  const integrations = new URL(integrationsUrl);
  const users = [decodeURIComponent(core.username), decodeURIComponent(integrations.username)];
  if (![core.protocol, integrations.protocol].every((protocol) => ["postgres:", "postgresql:"].includes(protocol)) ||
    core.hostname !== integrations.hostname || (core.port || "5432") !== (integrations.port || "5432") ||
    core.pathname !== "/vital_core" || integrations.pathname !== "/vital_integrations" ||
    users.some((user) => !user || user === "postgres") || users[0] === users[1] ||
    [core, integrations].some((url) => [...url.searchParams.keys()].some((key) => /^ssl/i.test(key)))) {
    throw new Error("EDA requires one PostgreSQL host, vital_core/vital_integrations and distinct non-superuser identities.");
  }
}

export async function verifyRuntimePrivileges(pool: pg.Pool, ownDatabase: string, otherDatabase: string) {
  const result = await pool.query<{ safe: boolean }>(`SELECT
    current_database()=$1 AND current_setting('TimeZone')='UTC' AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolbypassrls
    AND NOT has_database_privilege(current_user,$1,'CREATE')
    AND NOT has_database_privilege(current_user,$2,'CONNECT')
    AND NOT has_schema_privilege(current_user,'public','CREATE') AS safe
    FROM pg_roles r WHERE r.rolname=current_user`, [ownDatabase, otherDatabase]);
  if (result.rows[0]?.safe !== true) throw new Error("UNSAFE_EDA_RUNTIME_DATABASE_PRIVILEGES");
}

export function createDatabases(mode: "api" | "worker", environment: NodeJS.ProcessEnv = process.env) {
  const coreUrl = environment.VITAL_CORE_DATABASE_URL ?? "";
  const integrationsUrl = environment.VITAL_INTEGRATIONS_DATABASE_URL ?? "";
  validateDatabaseBoundary(coreUrl, integrationsUrl);
  configureUtcDateParameters();
  const caFile = environment.VITAL_DATABASE_CA_FILE;
  const privateDatabase = environment.VITAL_EDA_PRIVATE_HTTP === 'true'
    && new URL(coreUrl).host === 'postgres:5432' && new URL(integrationsUrl).host === 'postgres:5432';
  if (environment.NODE_ENV === "production" && !caFile && !privateDatabase) throw new Error("Verified PostgreSQL TLS is required in production.");
  const ssl = !privateDatabase && caFile ? { ca: readFileSync(caFile, "utf8"), rejectUnauthorized: true } : undefined;
  const max = mode === "api" ? 4 : 2;
  const limits = { max, ssl, types:utcPgTypes,options:"-c timezone=UTC",connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000,
    statement_timeout: 10_000, query_timeout: 12_000, lock_timeout: 5000 };
  const corePool = new pg.Pool({ connectionString: coreUrl, ...limits });
  const integrationsPool = new pg.Pool({ connectionString: integrationsUrl, ...limits });
  const core = new CorePrismaClient({ adapter: new PrismaPg(corePool) });
  const integrations = new IntegrationsPrismaClient({ adapter: new PrismaPg(integrationsPool) });
  return {
    core, integrations, corePool, integrationsPool,
    async verifyPrivileges() {
      await verifyRuntimePrivileges(corePool, "vital_core", "vital_integrations");
      await verifyRuntimePrivileges(integrationsPool, "vital_integrations", "vital_core");
    },
    async close() { await Promise.all([core.$disconnect(), integrations.$disconnect()]); await Promise.all([corePool.end(), integrationsPool.end()]); },
  };
}
