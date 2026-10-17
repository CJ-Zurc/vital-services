import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "core/schema.prisma",
  migrations: { path: "core/migrations" },
  datasource: { url: process.env.VITAL_CORE_MIGRATION_URL ?? process.env.VITAL_CORE_DATABASE_URL },
});
