-- Explicit post-migration DML only. Never grant ownership, CREATE or migration-table access.
GRANT USAGE ON SCHEMA public TO :"api_role", :"worker_role";
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I, %I',
  schemaname, tablename, :'api_role', :'worker_role')
FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
\gexec
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"api_role", :"worker_role";
