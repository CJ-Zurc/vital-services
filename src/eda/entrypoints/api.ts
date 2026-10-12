import "dotenv/config";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { createDatabases } from "../infrastructure/databases.js";
import { createEdaApp } from "../http/app.js";
import { z } from "zod";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing EDA configuration: ${name}`);
  return value;
}

if (process.env.VITAL_EDA_ENABLED !== "true") throw new Error("EDA runtime is disabled; coordinated cutover has not been authorized.");
const databases = createDatabases("api");
const previousKeysFile = process.env.VITAL_BFF_PREVIOUS_PUBLIC_KEYS_FILE;
const previousKeys = previousKeysFile ? z.record(z.string().regex(/^[A-Za-z0-9_-]{1,96}$/),
  z.string().min(64).max(8192)).refine((value) => Object.keys(value).length <= 2).parse(JSON.parse(readFileSync(previousKeysFile, "utf8"))) : undefined;
const app = createEdaApp(databases.core, {
  issuer: "vital-web", audience: "vital-services", peerName: "vital-web",
  keyId: required("VITAL_BFF_SIGNING_KEY_ID"), publicKey: readFileSync(required("VITAL_BFF_SIGNING_PUBLIC_KEY_FILE"), "utf8"),
  previousKeys,
}, process.env.VITAL_EDA_PROFILE_WRITES_ENABLED === "true");
const server = createServer({ key: readFileSync(required("VITAL_API_TLS_KEY_FILE")), cert: readFileSync(required("VITAL_API_TLS_CERT_FILE")),
  ca: readFileSync(required("VITAL_SERVICE_CA_FILE")), requestCert: true, rejectUnauthorized: true, maxHeaderSize: 16384 }, app);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
void databases.verifyPrivileges().then(() => {
  server.listen(Number(process.env.VITAL_EDA_API_PORT ?? "8443"), "0.0.0.0", () => {
    console.log(JSON.stringify({ level: "info", event: "eda.api.started", migrationComplete: false }));
  });
}).catch(async () => {
  console.error(JSON.stringify({ level: "error", event: "eda.api.startup_rejected", code: "DATABASE_BOUNDARY_FAILED" }));
  await databases.close(); process.exitCode = 1;
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  server.closeIdleConnections();
  const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
  await new Promise<void>((resolve) => server.once("close", resolve));
  clearTimeout(deadline);
  await databases.close();
}
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
