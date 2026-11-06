# API contracts

The API is private HTTPS on port 8443. `/internal/v1/*` domain routes require
the Web mTLS peer and signed actor/request assertions. `/internal/readiness`
checks the two stores with the same mTLS peer without impersonating a user.
`/health` is process liveness; use readiness and runtime health for deployment.

The source route inventory is `src/eda/http/` and `src/eda/entrypoints/api.ts` and the module-owned HTTP adapters
under `src/eda/modules/`. Web implements browser compatibility adapters; Gateway
forwards only reviewed BFF/integration paths. Generic domain scaffolds are not routes.
