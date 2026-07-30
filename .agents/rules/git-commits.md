---
trigger: always_on
description: Defines the required format and structure for commit messages in the VITAL_Services repo. Mirrors the workspace-wide BGH commit convention.
---

# Git Commit Rules

## 1. Commit Structure

```
<type>(<scope>): <concise description in past-tense> [<TICKET_ID>]

- <Detailed bullet point>
- <Another bullet point>
```

### Components

1. **Type**: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`, `ci`, `revert`
2. **Scope**: module/feature name (e.g., `vital`, `appointment`, `telemedicine`, `internal`, `gateway`)
3. **Summary**: past-tense
4. **Project Tag**: `[VITAL-M0-F0]` (System-ModuleID-FeatureID)
5. **Body**: hyphenated list, relative file paths only

## Examples

```
feat(vital): added consolidated /internal/users/:user_id/roles endpoint [VITAL-M0-F0]

- Added src/routes/internal.js handler returning {system:"vital", roles:[]}
- Wired trustedGateway middleware in src/index.js
- Updated docs/api_reference.md and docs/integration_guide.md
```

```
fix(gateway): rejected requests missing X-Gateway-Secret with 403 [VITAL-M0-F1]

- Tightened src/middleware/trustedGateway.js
- Added security note to docs/security.md
```

## 2. Don'ts

- Do not skip the type or scope.
- Do not reference absolute paths in the body — keep them relative to repo root.
- Do not amend already-pushed commits unless explicitly requested.
- Do not bypass hooks (`--no-verify`) unless explicitly requested.
