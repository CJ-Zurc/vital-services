require("dotenv").config();

const config = {
  port: Number(process.env.PORT || 8009),
  paymongoSecret: process.env.PAYMONGO_SECRET || process.env.PAYMONGO_SECRET_KEY || "",
  internalServiceKey: process.env.VITAL_INTERNAL_SERVICE_KEY || process.env.JWT_SECRET || "",
  webToServicesInternalServiceKey:
    process.env.VITAL_WEB_TO_SERVICES_INTERNAL_SERVICE_KEY ||
    process.env.VITAL_INTERNAL_SERVICE_KEY ||
    "",
  servicesToWebInternalServiceKey:
    process.env.VITAL_SERVICES_TO_WEB_INTERNAL_SERVICE_KEY ||
    process.env.VITAL_INTERNAL_SERVICE_KEY ||
    "",
  vitalWebUrl: process.env.VITAL_WEB_URL || "http://localhost:3001",
  internalApiKey: process.env.INTERNAL_API_KEY || "",
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://postgres:password@localhost:5435/vital_services_db",
};

function validateConfig() {
  if (process.env.NODE_ENV !== "production") return;
  const required = {
    PAYMONGO_SECRET: config.paymongoSecret,
    DATABASE_URL: process.env.DATABASE_URL,
    VITAL_WEB_TO_SERVICES_INTERNAL_SERVICE_KEY:
      process.env.VITAL_WEB_TO_SERVICES_INTERNAL_SERVICE_KEY,
    VITAL_SERVICES_TO_WEB_INTERNAL_SERVICE_KEY:
      process.env.VITAL_SERVICES_TO_WEB_INTERNAL_SERVICE_KEY,
    VITAL_WEB_URL: process.env.VITAL_WEB_URL,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing required VITAL_Services production configuration: ${missing.join(", ")}`);
  }
}

module.exports = { ...config, validateConfig };
