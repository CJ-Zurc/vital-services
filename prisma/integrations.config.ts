import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "integrations/schema.prisma",
  migrations: { path: "integrations/migrations" },
  datasource: { url: process.env.VITAL_INTEGRATIONS_MIGRATION_URL ?? process.env.VITAL_INTEGRATIONS_DATABASE_URL },
});
