require("dotenv").config();

module.exports = {
  port: Number(process.env.PORT || 4001),
  paymongoSecret: process.env.PAYMONGO_SECRET || process.env.PAYMONGO_SECRET_KEY || "",
  internalServiceKey: process.env.VITAL_INTERNAL_SERVICE_KEY || process.env.JWT_SECRET || "",
  vitalWebUrl: process.env.VITAL_WEB_URL || "http://localhost:3000",
  internalApiKey: process.env.INTERNAL_API_KEY || "",
};
