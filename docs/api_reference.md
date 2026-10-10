# API reference

The implementation is `src/index.js` and `src/routes/vital.js`. Paths in this
table are service paths; Gateway removes `/vital` for its forwarded requests.

| Method/path | Access | Current behavior |
|---|---|---|
| `GET /health` | Public health probe | `{"success":true,"data":{"service":"vital-services"}}` |
| `POST /payments/paymongo/checkouts` | Internal VITAL_WEB caller | Create/replay a checkout operation |
| `GET /payments/paymongo/checkouts/{checkoutSessionId}` | Internal VITAL_WEB caller | Retrieve provider checkout state |
| `POST /payments/paymongo/checkouts/{checkoutSessionId}/expire` | Internal VITAL_WEB caller | Expire checkout |
| `POST /payments/paymongo/refunds` | Internal VITAL_WEB caller | Create/replay a refund operation |
| `POST /jobs/appointments/auto-complete` | Internal caller | Forward to VITAL_WEB `/api/internal/appointments/auto-complete` |
| `POST /webhooks/paymongo` | Unauthenticated placeholder | `202` reservation message only; no signature verification or payment processing |
| `GET /healthz` | Gateway trust | `{"status":"ok","scope":"vital"}` |
| `GET /appointments` | Gateway trust | Empty `items` with an explicit scaffold note |
| `GET /telemedicine` | Gateway trust | Empty `items` with an explicit scaffold note |

Browser-facing operational records are owned by `VITAL_WEB` BFF routes and its
Gateway `/vital/integrations/v1/*` projection. Auth role lookup also belongs to
`VITAL_WEB /internal/users/{user_id}/roles`.

## Payment mutation contract

Checkout requires `operationKey`, `appointmentId`, `amount`, `successUrl`, and
`cancelUrl`; `description` is optional. Refund requires `operationKey`,
`paymentId`, `appointmentId`, and `amount`; `reason` is optional.

Operations expose `pending`, `completed`, `failed`, or `unknown` status.
Pending operations return `202`. Completed and unknown operations replay stored
state; a matching failed operation is retried on resubmission. Reusing a key for
different inputs or operation types returns `409`. An exception with a provider
response is classified as failed; one without a response stays unknown for
reconciliation. That classification does not independently establish whether
the provider performed a mutation.

`X-Correlation-ID` is read/generated and echoed. Gateway trust errors return
`403 forbidden_untrusted_caller` or `500 gateway_secret_not_configured`.
Internal authentication can return `401` or configuration failure; see
[security](security.md). Do not treat placeholder webhook acceptance as delivery.
