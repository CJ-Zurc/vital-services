import type { Pool } from "pg";
import { S3RecordsStorage } from "../records/storage.js";
import { ClamAvScanner } from "../records/scanner.js";
import { createProfileQrRepository } from "./profile-qr-repository.js";
import { createProfileQrModule } from "./profile-qr.js";

export function profileQrRuntime(databases: { corePool: Pool }, environment: NodeJS.ProcessEnv = process.env) {
  if (environment.VITAL_EDA_PROFILE_QR_ENABLED !== "true") return undefined;
  if (environment.VITAL_EDA_ENABLED !== "true" || environment.VITAL_EDA_PROFILE_WRITES_ENABLED !== 'true') throw new Error("PROFILE_QR_RUNTIME_DISABLED");
  const required = (name: string) => { const value = environment[name]; if (!value?.trim()) throw new Error(`PROFILE_QR_CONFIGURATION_MISSING:${name}`); return value; };
  const storage = new S3RecordsStorage({ endpoint: required("VITAL_PROFILE_QR_STORAGE_ENDPOINT"),
    publicEndpoint: required("VITAL_PROFILE_QR_STORAGE_ENDPOINT"), bucket: required("VITAL_PROFILE_QR_STORAGE_BUCKET"),
    region: required("VITAL_PROFILE_QR_STORAGE_REGION"), accessKeyId: required("VITAL_PROFILE_QR_STORAGE_ACCESS_KEY"),
    secretAccessKey: required("VITAL_PROFILE_QR_STORAGE_SECRET_KEY"), quarantinePrefix: "quarantine/profile-qr/", finalPrefix: "profile-qr/final/" });
  const scanner = new ClamAvScanner({ socketPath: required("VITAL_PROFILE_QR_CLAMAV_SOCKET"), daemonConfigPath: required("VITAL_PROFILE_QR_CLAMAV_CONFIG"), deadlineMs: 15000, maxDatabaseAgeMs: 86400000 });
  return createProfileQrModule(createProfileQrRepository(databases.corePool), storage, scanner);
}
