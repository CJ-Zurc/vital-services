const express = require('express');
require('dotenv').config();

const correlationId = require('./middleware/correlationId');
const trustedGateway = require('./middleware/trustedGateway');
const internalRoutes = require('./routes/internal');
const vitalRoutes = require('./routes/vital');

const app = express();
const port = parseInt(process.env.PORT, 10) || 8009;

app.use(express.json());
app.use(correlationId);

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'vital-services' });
});

app.use('/internal', trustedGateway, internalRoutes);
app.use('/vital', trustedGateway, vitalRoutes);

app.use((err, req, res, _next) => {
  console.error(JSON.stringify({
    level: 'error',
    correlation_id: req.correlationId,
    message: err.message,
    stack: err.stack,
  }));
  res.status(500).json({ error: 'internal_error', correlation_id: req.correlationId });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`vital-services listening on :${port}`);
});

module.exports = app;
