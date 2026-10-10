# Testing

The repository uses Node's built-in test runner through `package.json`:

```powershell
npm ci
npm run lint
npm test
```

Run from `VITAL_Services`. `test/app.test.js` covers HTTP health/internal routes;
`test/payment-operations.test.js` covers duplicate operations, concurrent
claiming, and ambiguous provider failures. Inspect tests before assuming they
exercise live PostgreSQL or PayMongo: provider/database behavior is isolated
where the suite substitutes dependencies.

Runtime startup/health verification is separate. Follow [deployment](deployment.md)
for the scoped API rebuild and `GET /health`. Expected health response is
`{"success":true,"data":{"service":"vital-services"}}`. The suite exists;
there is no pytest, Vitest, or Supertest command in the current package scripts.
