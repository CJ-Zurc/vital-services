# Clinical specialty seed and recovery contract

Manifest v2 includes explicit hospital and specialty pairs plus the TRACE-issued
categorized catalog. The strict seed adapter verifies UUID/name/category pairing,
owner-issued EHR patient links and identity uniqueness. Hospital IDs cannot be
doctor specialties. Clinical doctor fields retain their current names
`departmentExternalId/departmentName` and `specialty`.

Baseline doctors retain specialty UUIDs and use the existing Internal Medicine,
Cardiology, Pediatrics rotation. Known legacy labels on existing doctors normalize
through the supplied catalog. Changed profile versions emit the existing durable
doctor-mirror effects to EHR. Existing IDs, roles, consent and onboarding state
remain intact; repeating reconciliation is idempotent.

Tools-only runtime modes `catalog-snapshot` and `catalog-restore` use the
existing gated migrator credential boundary. Snapshot stdout is private metadata;
restore consumes stdin, checks doctor identity/role, increments versions and
emits doctor mirrors rather than decrementing profile versions. Ordinary API and
worker processes do not receive migrator credentials. Pause browser writes and
coordinate mirror draining during recovery.

See the [workspace contract](../../Documents/Department_Catalog_Integration_Guide_v1.md)
and [cutover runbook](../../docs/deployment/department-catalog-cutover.md).
