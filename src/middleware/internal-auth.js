const { internalServiceKey, internalApiKey } = require("../config");

function requireInternalService(req, res, next) {
  if (internalApiKey && req.header("X-Internal-Api-Key") === internalApiKey) {
    return next();
  }
  if (!internalServiceKey) {
    return res.status(500).json({ success: false, message: "Internal service key is not configured." });
  }
  if (req.header("X-Internal-Service-Key") !== internalServiceKey) {
    return res.status(401).json({ success: false, message: "Unauthorized service request." });
  }
  next();
}

module.exports = { requireInternalService };
