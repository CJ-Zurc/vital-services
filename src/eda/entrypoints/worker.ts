import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { createDatabases } from "../infrastructure/databases.js";
import { connectBroker, consumeEvents } from "../infrastructure/broker.js";
import { dispatchOutbox } from "../infrastructure/outbox.js";
import { publishConfirmed } from "../infrastructure/broker.js";
import { exchangeFor } from "../contracts/events.js";
import { enqueueAudit, enqueueNotification, deliverPending } from "../modules/platform-delivery/delivery.js";
import { consumePayment, consumeProfile } from "../workers/handlers.js";
import { consumeProfileSync, deliverProfileSync } from "../modules/profile/profile-delivery.js";
import { paymentRuntime } from "../modules/payment/payment-runtime.js";
import { readPaymentProjectionAppointment } from "../modules/appointment/appointment-billing.js";
import { appointmentRuntime } from "../modules/appointment/appointment-runtime.js";
import { consumeAppointmentPayment } from "../workers/appointment-payment.js";
import { consumeSagaCommand } from "../workers/appointment-saga.js";
import { recordsRuntime } from "../modules/records/runtime.js";
import { consumeRecordsEvent } from "../workers/records.js";
import { videoRuntime } from '../modules/video/runtime.js';
import { consumeVideoWorkflow,consumeVideoFact } from '../workers/video.js';
import { messagingRuntime } from '../modules/messaging/runtime.js';
import { runtimeHealth } from '../infrastructure/runtime-health.js';
import { consumeMessagingEvent } from '../workers/messaging.js';
import { profileQrRuntime } from '../modules/profile/profile-qr-runtime.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing EDA worker configuration: ${name}`);
  return value;
}
if (process.env.VITAL_EDA_ENABLED !== "true") throw new Error("EDA worker is disabled before coordinated cutover.");
const databases = createDatabases("worker");
const health = runtimeHealth('worker');
health.unavailable();
const payment = paymentRuntime(databases);
const records=recordsRuntime(databases,payment);
const video=videoRuntime(databases);
const appointment=appointmentRuntime(databases,payment,process.env,records,video);
const messaging=messagingRuntime(databases);
const profileQr = profileQrRuntime(databases);
let lastVideoScan=0;
let lastAppointmentScan=0;
let lastPaymentScan = 0;
let closing = false;
const shutdown=new AbortController();
process.once("SIGTERM", () => { closing = true;shutdown.abort(); });
process.once("SIGINT", () => { closing = true;shutdown.abort(); });

async function run() {
  await databases.verifyPrivileges();
  while (!closing) {
    let connection: Awaited<ReturnType<typeof connectBroker>> | undefined;
    const consumers: Awaited<ReturnType<typeof consumeEvents>>[] = [];
    try {
      connection = await connectBroker(required("VITAL_RABBITMQ_URL"), required("VITAL_RABBITMQ_CA_FILE"));
      let brokerClosed = false;
      connection.on("error", () => { brokerClosed = true; health.unavailable(); });
      connection.on("close", () => { brokerClosed = true; health.unavailable(); });
      const publisher = await connection.createConfirmChannel();
      publisher.on("error", () => { brokerClosed = true; health.unavailable(); });
      publisher.on("close", () => { brokerClosed = true; health.unavailable(); });
      if (process.env.VITAL_EDA_CONSUMERS_ENABLED === "true") {
        consumers.push(await consumeEvents(connection, "appointment-payment", (event) => consumePayment(databases.corePool, databases.integrationsPool, event, readPaymentProjectionAppointment)));
        if(appointment)consumers.push(await consumeEvents(connection,"appointment-confirmation",event=>consumeAppointmentPayment(databases.corePool,databases.integrationsPool,event,appointment.module.confirmPayment)));
        if(appointment)consumers.push(await consumeEvents(connection,'appointment-saga',event=>consumeSagaCommand(databases.corePool,event)));
        if(records){consumers.push(await consumeEvents(connection,'records-artifact',event=>consumeRecordsEvent(databases.corePool,event,'records-artifact')));
          consumers.push(await consumeEvents(connection,'records-appointment',event=>consumeRecordsEvent(databases.corePool,event,'records-appointment')));}
        if(video){consumers.push(await consumeEvents(connection,'video-workflow',event=>consumeVideoWorkflow(databases.corePool,event)));
          consumers.push(await consumeEvents(connection,'video-state',event=>consumeVideoFact(databases.integrationsPool,event)));}
        if(messaging){consumers.push(await consumeEvents(connection,'messaging-appointment',event=>consumeMessagingEvent(databases.corePool,event,'messaging-appointment')));
          consumers.push(await consumeEvents(connection,'messaging-state',event=>consumeMessagingEvent(databases.corePool,event,'messaging-state')));}
        consumers.push(await consumeEvents(connection, "profile-projection", (event) => consumeProfile(databases.corePool, databases.integrationsPool, event)));
        consumers.push(await consumeEvents(connection, "profile-sync", (event) => consumeProfileSync(databases.corePool, databases.integrationsPool, event)));
        consumers.push(await consumeEvents(connection, "platform-audit", (event) => enqueueAudit(databases.integrationsPool, event)));
        consumers.push(await consumeEvents(connection, "platform-notification", (event) => enqueueNotification(databases.integrationsPool, event)));
      }
      console.log(JSON.stringify({ level: "info", event: "eda.worker.connected", consumerCount: consumers.length, migrationComplete: false }));
      while (!closing && !brokerClosed && consumers.every((consumer) => consumer.healthy())) {
        health.ready();
        const publish = (event: Parameters<typeof publishConfirmed>[3]) => publishConfirmed(publisher, exchangeFor(event.producer), event.eventType, event);
        await dispatchOutbox(databases.corePool, publish);
        await dispatchOutbox(databases.integrationsPool, publish);
        if (process.env.VITAL_EDA_DELIVERY_ENABLED === "true") await deliverPending(databases.integrationsPool, {
          audit: { baseUrl: required("VITAL_AUDIT_URL"), key: required("AUDIT_VITAL_INGEST_KEY") },
          notification: { baseUrl: required("VITAL_NOTIFICATION_URL"), key: required("VITAL_NOTIFICATION_INGEST_KEY") },
        });
        if (process.env.VITAL_EDA_PROFILE_SYNC_ENABLED === "true") await deliverProfileSync(databases.corePool, databases.integrationsPool, {
          auth: { baseUrl: required("VITAL_AUTH_INTERNAL_URL"), key: required("VITAL_SERVICES_AUTH_STALE_KEY") },
          ehr: { baseUrl: required("VITAL_EHR_INTERNAL_URL"), key: required("VITAL_SERVICES_EHR_MIRROR_KEY") },
        });
        if (process.env.VITAL_EDA_PAYMENT_RECONCILE_ENABLED === "true" && payment && Date.now() - lastPaymentScan >= 60_000) {
          lastPaymentScan = Date.now();
          await payment.workerTick();
        }
        if(process.env.VITAL_EDA_APPOINTMENT_MAINTENANCE_ENABLED==="true"&&appointment&&Date.now()-lastAppointmentScan>=15000){
          lastAppointmentScan=Date.now();await appointment.maintenanceTick();
        }
        if(records)await records.artifactTick(shutdown.signal);
        if(profileQr)await profileQr.recoverOnce(shutdown.signal);
        if(messaging){const retention=await messaging.retentionTick(shutdown.signal);
          if(retention&&!retention.busy&&(retention.scanned>0||retention.completed))console.log(JSON.stringify({level:'info',event:'eda.messaging.retention',mode:retention.mode,scanned:retention.scanned,eligible:retention.eligible,purged:retention.purged,completed:retention.completed}));}
        if(video&&process.env.VITAL_EDA_VIDEO_MAINTENANCE_ENABLED==='true'&&Date.now()-lastVideoScan>=15000){lastVideoScan=Date.now();await video.tick();}
        await sleep(1000);
      }
      await publisher.close().catch(() => undefined);
    } catch {
      console.error(JSON.stringify({ level: "error", event: "eda.worker.dependency_unavailable", code: "WORKER_DEPENDENCY_FAILED" }));
    } finally {
      health.unavailable();
      await Promise.allSettled(consumers.map((consumer) => consumer.close()));
      await connection?.close().catch(() => undefined);
    }
    if (!closing) await sleep(5000);
  }
  await databases.close();
  health.unavailable();
}

void run().catch(async () => { console.error(JSON.stringify({ level: "error", event: "eda.worker.failed" }));
  await databases.close(); process.exitCode = 1; });
