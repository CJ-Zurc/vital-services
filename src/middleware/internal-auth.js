const { internalServiceKey } = require("../config");

function requireInternalService(req, res, next) {
  if (!internalServiceKey) {
    return res.status(500).json({ success: false, message: "Internal service key is not configured." });
  }
  if (req.header("X-Internal-Service-Key") !== internalServiceKey) {
    return res.status(401).json({ success: false, message: "Unauthorized service request." });
  }
  next();
}

module.exports = { requireInternalService };
