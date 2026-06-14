const {
  internalServiceKey,
  internalApiKey,
  webToServicesInternalServiceKey,
} = require("../config");

function requireInternalService(req, res, next) {
  if (internalApiKey && req.header("X-Internal-Api-Key") === internalApiKey) {
    return next();
  }
  const caller = (req.header("X-Internal-Service") || "").trim().toLowerCase();
  const providedKey = req.header("X-Internal-Service-Key");
  if (
    caller === "vital-web" &&
    webToServicesInternalServiceKey &&
    providedKey === webToServicesInternalServiceKey
  ) {
    return next();
  }
  if (!webToServicesInternalServiceKey && !internalServiceKey) {
    return res.status(500).json({ success: false, message: "Internal service key is not configured." });
  }
  if (providedKey !== internalServiceKey) {
    return res.status(401).json({ success: false, message: "Unauthorized service request." });
  }
  next();
}

module.exports = { requireInternalService };
