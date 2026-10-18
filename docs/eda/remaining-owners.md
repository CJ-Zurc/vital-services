# Remaining Owner Contracts

Updated 2026-10-16. Default-off source checkpoint, not runtime acceptance.
No layout, public appointment lifecycle, port or provider action is introduced.

| Browser path/method | Private owner | Authority and compatibility |
| --- | --- | --- |
| GET `/api/doctor/dashboard` | GET `/internal/v1/appointments/dashboard` | Current owning doctor; complete status/patient/today aggregates, five today and five pending cards, current Payment/Video composition and revision fences. |
| POST `/api/patient/ehr-record-notice` | POST `/internal/v1/profile/patient/ehr-record-notice` | Own current patient, strict empty input, Profile writes, signed idempotent command; `{success:true}` and session headers preserved. |
| POST `/api/appointments/{id}/feedback` | POST `/internal/v1/appointments/{id}/feedback` | Own current patient; confirmed/completed appointment, current verified paid association, expected revision and calendar lock; existing review envelope preserved. |
| GET `/api/doctor/patients/{id}/opqrst` | GET `/internal/v1/appointments/patients/{id}/intakes` | Current doctor and assigned patient rows only; legacy active/completed states; keyset batches preserve actual submitted timestamps and complete browser array. |

Notice dismissal is monotonic and rechecks patient membership before replay.
Its deterministic body-free operation ID does not require a UI change. Feedback
upsert, derived doctor rating, reference-only command result and content-free
central audit intent commit together. Replay validates command hash and current
ownership; it neither emits duplicate audit nor stores review text in the command
journal. Browser feedback validates same origin and uses the current owner
revision. Patient/doctor identifiers, amounts and eligibility are never client
authority.

Intake bodies remain in Core and authorized HTTP responses, not RabbitMQ/audit.
Ten-row private pages use the existing bounded clinical response allowance;
large assessments cannot silently truncate the legacy browser array.
The exact internal cursor parameters are allowlisted and all SQL values use
bindings. Remaining dynamic table/column choices come only from closed owner
constants; Payment write helpers additionally reject tables outside their fixed
map. Tests exercise hostile text as bound data. This is not a general claim that
all possible SQL injection paths or real database concurrency have been proved.

`SystemContent` is retained schema-only Profile ownership: no current authoring
route or UI consumer was found. Current payment-QR consumers are doctor-owned;
no patient QR screen or independent access workflow is invented. Existing QR
validation/scanning/ready-asset rules remain unchanged.

Portal/staff contracts are documented separately in `portal-integrations.md`.
Foreign-admin doctor provisioning and complete staff Appointment/Payment/Video
composition remain explicit gates. Ordinary list overflow also remains. Doctor
dashboard aggregates now cover the whole history and hydrate only its bounded
cards; Manila date, slot-date precedence, source versions and current membership
are checked without deriving totals from those cards. Web still contains legacy operational
imports; removing Prisma/provider/storage dependencies before replacement parity
would break unmigrated routes/tests and is not claimed complete.

Focused unit/HTTP fixtures and opt-in real PostgreSQL scenarios are registered in
the root test catalog. Real database/broker/mTLS execution, provider acceptance,
ingress/SSE and browser workflow evidence remain separate required gates.
