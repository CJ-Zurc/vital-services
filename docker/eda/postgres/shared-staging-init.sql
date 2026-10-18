\set ON_ERROR_STOP on
-- Run through psql against the existing VITAL PostgreSQL instance. The caller
-- supplies the six password variables over stdin; no secret appears in argv.
-- Only the two owned VITAL databases and their scoped roles are provisioned.

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', name, password)
FROM (VALUES
  ('vital_core_api', :'core_api_password'),
  ('vital_core_worker', :'core_worker_password'),
  ('vital_core_migrator', :'core_migrator_password'),
  ('vital_integrations_api', :'integrations_api_password'),
  ('vital_integrations_worker', :'integrations_worker_password'),
  ('vital_integrations_migrator', :'integrations_migrator_password')
) AS roles(name, password)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = roles.name)
\gexec

SELECT 'CREATE DATABASE vital_core OWNER vital_core_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'vital_core')
\gexec
SELECT 'CREATE DATABASE vital_integrations OWNER vital_integrations_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'vital_integrations')
\gexec

REVOKE ALL ON DATABASE vital_core, vital_integrations FROM PUBLIC;
GRANT CONNECT ON DATABASE vital_core TO vital_core_api, vital_core_worker;
GRANT CONNECT ON DATABASE vital_integrations TO vital_integrations_api, vital_integrations_worker;

\connect vital_core
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO vital_core_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE vital_core_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE vital_core_migrator IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE vital_core_migrator IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

\connect vital_integrations
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO vital_integrations_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE vital_integrations_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE vital_integrations_migrator IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE vital_integrations_migrator IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
