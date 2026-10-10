# Flows

## Payment operation

VITAL_WEB sends a directional-key authenticated payment request with a stable
operation key. VITAL_Services claims the shared PostgreSQL ledger entry before
calling PayMongo. Duplicate keys replay completed, pending, or unknown state;
a matching failed operation is claimed again and retried. Conflicting payloads
or operation types return `409`. Exceptions without a provider response persist
as unknown; exceptions with a response persist as failed.

## Appointment auto-completion

An internal caller invokes `/jobs/appointments/auto-complete`. This service
forwards to VITAL_WEB `/api/internal/appointments/auto-complete` using caller
`vital-services`, its outbound directional key, and the correlation ID.
VITAL_WEB owns the actual appointment mutation.

## Gateway scaffolds

Gateway `/vital/healthz`, `/vital/appointments`, and `/vital/telemedicine` strip
`/vital`. Correlation middleware runs before Gateway trust. After trust
validation, these handlers return the health scope or explicitly empty scaffold
responses. They currently do not write appointments or publish audit events.

Auth role aggregation goes directly to VITAL_WEB. Audit publishing and direct
Auth enrichment are future VITAL_Services integrations; see
[integration_guide.md](integration_guide.md).
