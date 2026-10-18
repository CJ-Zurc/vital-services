import "dotenv/config";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { createDatabases } from "../infrastructure/databases.js";
import { createEdaApp } from "../http/app.js";
import { z } from "zod";
import { getProfileSyncStatuses } from "../modules/profile/profile-delivery.js";
import { paymentRuntime } from "../modules/payment/payment-runtime.js";
import { appointmentRuntime } from "../modules/appointment/appointment-runtime.js";
import { recordsRuntime } from "../modules/records/runtime.js";
import { videoRuntime } from '../modules/video/runtime.js';
import { messagingRuntime } from '../modules/messaging/runtime.js';
import { createChangeFeed } from '../infrastructure/change-feed.js';
import { runtimeHealth } from '../infrastructure/runtime-health.js';
import { completionRuntime } from '../modules/composition/completion-runtime.js';
import { profileQrRuntime } from '../modules/profile/profile-qr-runtime.js';
import { createAppointmentExtras } from '../modules/appointment/appointment-extras.js';
import { portalIntegrationsRuntime } from '../modules/portal-integrations/portal-integrations-runtime.js';
import { createAppointmentCommandPreparation } from '../modules/appointment/appointment-command-preparation.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing EDA configuration: ${name}`);
  return value;
}

if (process.env.VITAL_EDA_ENABLED !== "true") throw new Error("EDA runtime is disabled; coordinated cutover has not been authorized.");
const databases = createDatabases("api");
const health = runtimeHealth('api');
health.unavailable();
const payment=paymentRuntime(databases);
const records=recordsRuntime(databases,payment);
const video=videoRuntime(databases);
const appointment=appointmentRuntime(databases,payment,process.env,records,video);
const messaging=messagingRuntime(databases);
const completion = completionRuntime(databases, appointment, process.env, video);
const profileQr = profileQrRuntime(databases);
const sse = process.env.VITAL_EDA_SSE_ENABLED === 'true';
if (sse && (!appointment || !messaging)) throw new Error('SSE_OWNERS_REQUIRED');
const feed = sse ? createChangeFeed(databases.corePool) : undefined;
const previousKeysFile = process.env.VITAL_BFF_PREVIOUS_PUBLIC_KEYS_FILE;
const previousKeys = previousKeysFile ? z.record(z.string().regex(/^[A-Za-z0-9_-]{1,96}$/),
  z.string().min(64).max(8192)).refine((value) => Object.keys(value).length <= 2).parse(JSON.parse(readFileSync(previousKeysFile, "utf8"))) : undefined;
const app = createEdaApp(databases.core, {
  issuer: "vital-web", audience: "vital-services", peerName: "vital-web",
  keyId: required("VITAL_BFF_SIGNING_KEY_ID"), publicKey: readFileSync(required("VITAL_BFF_SIGNING_PUBLIC_KEY_FILE"), "utf8"),
  previousKeys,
}, process.env.VITAL_EDA_PROFILE_WRITES_ENABLED === "true",
  (authIds) => getProfileSyncStatuses(databases.corePool, databases.integrationsPool, authIds), payment,appointment,records,video,messaging,
  feed && messaging && appointment ? { feed, authorizeMessage: messaging.messages.authorizeStream, requests: appointment.listRequests } : undefined, completion, profileQr,
  appointment ? createAppointmentExtras(databases.corePool, payment ? { financial: { verifyPaid: payment.verifyAppointmentPaid } } : {}) : undefined,
  portalIntegrationsRuntime(databases), appointment ? createAppointmentCommandPreparation(databases.corePool) : undefined);
const server = createServer({ key: readFileSync(required("VITAL_API_TLS_KEY_FILE")), cert: readFileSync(required("VITAL_API_TLS_CERT_FILE")),
  ca: readFileSync(required("VITAL_SERVICE_CA_FILE")), requestCert: true, rejectUnauthorized: true, maxHeaderSize: 16384 }, app);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
let probing = false;
const probe = setInterval(() => {
  if (probing || !server.listening) return;
  probing = true;
  void Promise.all([databases.corePool.query('SELECT 1'), databases.integrationsPool.query('SELECT 1')])
    .then(() => { if (server.listening) health.ready(); })
    .catch(() => health.unavailable()).finally(() => { probing = false; });
}, 20_000);
probe.unref();
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
  clearInterval(probe); health.unavailable();
  feed?.close();
  server.close();
  server.closeIdleConnections();
  const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
  await new Promise<void>((resolve) => server.once("close", resolve));
  clearTimeout(deadline);
  await databases.close();
}
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
