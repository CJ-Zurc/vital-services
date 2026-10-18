# VITAL_Services Service Rules

This file is the canonical guidance for agents working in `VITAL_Services`.
`CLAUDE.md` and `GEMINI.md` point here.

Before making code changes in this service, you MUST review the local rules and documentation:

1. `.agents/rules/*`
2. `.agents/skills/*` (if applicable)
3. `docs/README.md`
4. `docs/integration_guide.md` (Gateway/Auth/Audit contract)

**Cross-Service Work:** If your task spans multiple services, refer to the root workspace context:

- `../AGENTS.md`
- `../Documents/VITAL_Integration_Guide_v1.md`

Stable rules:

- API accepts only the mTLS Web peer and verifies signed actor assertions. Never trust browser-supplied identity headers. API and worker have separate least-privilege database roles.
- Preserve `X-Correlation-ID` across downstream and internal calls.
- Do not connect to or query the Auth database; use protected Auth
  `/internal/*` calls for trusted enrichment.
- Keep actual env files schema-aligned with their examples without replacing
  environment-specific secrets.
- Root Compose owns bounded API, worker, scanner and infrastructure resources. Use `Dockerfile` runtime/tools targets; migrations and baseline seeding run only in tools.

Local skills:

- Use `.agents/skills/docker-rebuild/SKILL.md` when asked to rebuild or restart
  VITAL Services containers.
- Use `.agents/skills/git-commits/SKILL.md` when asked to draft or execute a
  commit for this repo.
