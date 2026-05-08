module.exports = function trustedGateway(req, res, next) {
  const enabled = (process.env.GATEWAY_TRUST_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    return next();
  }

  const expected = process.env.GATEWAY_SECRET;
  if (!expected) {
    return res.status(500).json({
      error: 'gateway_secret_not_configured',
      correlation_id: req.correlationId,
    });
  }

  const presented = req.header('X-Gateway-Secret');
  if (presented !== expected) {
    return res.status(403).json({
      error: 'forbidden_untrusted_caller',
      correlation_id: req.correlationId,
    });
  }

  req.gatewayTrusted = true;
  req.user = {
    id: req.header('X-User-Id') || null,
    email: req.header('X-User-Email') || null,
    roles: (req.header('X-User-Roles') || '').split(',').filter(Boolean),
    systemContext: req.header('X-System-Context') || null,
  };

  next();
};
