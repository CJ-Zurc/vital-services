# API contracts

The API is private HTTPS on port 8443. `/internal/v1/*` domain routes require
the Web mTLS peer and signed actor/request assertions. `/internal/readiness`
checks the two stores with the same mTLS peer without impersonating a user.
`/health` is process liveness; use readiness and runtime health for deployment.

The source route inventory is `src/eda/http/` and `src/eda/entrypoints/api.ts` and the module-owned HTTP adapters
under `src/eda/modules/`. Web implements browser compatibility adapters; Gateway
forwards only reviewed BFF/integration paths. Generic domain scaffolds are not routes.

See [face-to-face booking](f2f-booking.md) for booking-only acceptance, doctor outcomes, acknowledgment routes and paired rollout.

## Native TRACE disputes

See [the implemented contract and rollout ledger](integrations/trace/patient-feedback/VITAL_TRACE_Implementation_Changes_and_Verification.md). All native cross-system delivery uses Gateway; callbacks enter after JSON parsing and the existing Web mTLS/signed assertion boundary. `VITAL_TRACE_DISPUTES_ENABLED` defaults off. Complete resumes original payment/clinical checks; refund issuance is separate.
