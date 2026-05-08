# Flows

## Browser → VITAL request

```
browser
  │
  │  cookie session
  ▼
BGH_API_GATEWAY
  │  validates session/JWT
  │  performs silent refresh if needed
  │  injects X-Gateway-Secret + X-User-*
  │  preserves X-Correlation-ID
  ▼
VITAL_Services :8009
  │  trustedGateway: validates X-Gateway-Secret, extracts X-User-*
  │  correlationId: ensures X-Correlation-ID
  │  route handler
  │  → reads/writes vital-services-db
  │  → publishes audit envelope to RabbitMQ (audit.events)
  │  → may call UHSE_AUTH /internal/* directly
  ▼
response (with X-Correlation-ID echoed)
```

## Auth role aggregation

```
UHSE_AUTH
  │  internal service key
  │  X-Correlation-ID
  ▼
VITAL_Services /internal/users/{user_id}/roles
  │
  ▼
{ "system": "vital", "user_id": "...", "roles": [...] }
```

## Audit publishing

```
VITAL_Services
  │  RabbitMQ publish
  │  exchange = audit.events
  │  routing key per envelope spec
  ▼
BGH_AUDIT_LOGS audit-consumer
  ▼
MongoDB (queryable via Gateway /audit-logs/*)
```
