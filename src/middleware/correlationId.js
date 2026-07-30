const crypto = require('crypto');

module.exports = function correlationId(req, res, next) {
  const incoming = req.header('X-Correlation-ID');
  const id = incoming && incoming.length > 0 ? incoming : crypto.randomUUID();
  req.correlationId = id;
  res.setHeader('X-Correlation-ID', id);
  next();
};
