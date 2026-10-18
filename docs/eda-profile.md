# Profile ownership

Core owns the VITAL user/patient/doctor/admin projections. Auth issues identity
UUIDs and owns credentials; EHR owns patient and clinical identifiers; TRACE owns
department UUIDs. Mutations use guarded operation IDs and transactional outbox
effects. Worker synchronization invalidates Auth projections through directional
contracts. No cross-owner SQL or implicit consent is permitted.

Baseline tools consume the Auth-issued identity manifest enriched by TRACE and
EHR. Existing correct links are unchanged on repeat runs. See [configuration](configuration.md).
