import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { createDatabases } from "../infrastructure/databases.js";
import { connectBroker, consumeEvents } from "../infrastructure/broker.js";
import { dispatchOutbox } from "../infrastructure/outbox.js";
import { publishConfirmed } from "../infrastructure/broker.js";
import { exchangeFor } from "../contracts/events.js";
import { enqueueAudit, enqueueNotification, deliverPending } from "../modules/integrations/delivery.js";
import { consumePayment, consumeProfile } from "../workers/handlers.js";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing EDA worker configuration: ${name}`);
  return value;
}
if (process.env.VITAL_EDA_ENABLED !== "true") throw new Error("EDA worker is disabled before coordinated cutover.");
const databases = createDatabases("worker");
let closing = false;
process.once("SIGTERM", () => { closing = true; });
process.once("SIGINT", () => { closing = true; });

async function run() {
  await databases.verifyPrivileges();
  while (!closing) {
    let connection: Awaited<ReturnType<typeof connectBroker>> | undefined;
    const consumers: Awaited<ReturnType<typeof consumeEvents>>[] = [];
    try {
      connection = await connectBroker(required("VITAL_RABBITMQ_URL"), required("VITAL_RABBITMQ_CA_FILE"));
      let brokerClosed = false;
      connection.on("error", () => { brokerClosed = true; });
      connection.on("close", () => { brokerClosed = true; });
      const publisher = await connection.createConfirmChannel();
      publisher.on("error", () => { brokerClosed = true; });
      publisher.on("close", () => { brokerClosed = true; });
      if (process.env.VITAL_EDA_CONSUMERS_ENABLED === "true") {
        consumers.push(await consumeEvents(connection, "appointment-payment", (event) => consumePayment(databases.corePool, databases.integrationsPool, event)));
        consumers.push(await consumeEvents(connection, "profile-projection", (event) => consumeProfile(databases.corePool, databases.integrationsPool, event)));
        consumers.push(await consumeEvents(connection, "platform-audit", (event) => enqueueAudit(databases.integrationsPool, event)));
        consumers.push(await consumeEvents(connection, "platform-notification", (event) => enqueueNotification(databases.integrationsPool, event)));
      }
      console.log(JSON.stringify({ level: "info", event: "eda.worker.connected", consumerCount: consumers.length, migrationComplete: false }));
      while (!closing && !brokerClosed && consumers.every((consumer) => consumer.healthy())) {
        const publish = (event: Parameters<typeof publishConfirmed>[3]) => publishConfirmed(publisher, exchangeFor(event.producer), event.eventType, event);
        await dispatchOutbox(databases.corePool, publish);
        await dispatchOutbox(databases.integrationsPool, publish);
        if (process.env.VITAL_EDA_DELIVERY_ENABLED === "true") await deliverPending(databases.integrationsPool, {
          audit: { baseUrl: required("VITAL_AUDIT_URL"), key: required("AUDIT_VITAL_INGEST_KEY") },
          notification: { baseUrl: required("VITAL_NOTIFICATION_URL"), key: required("VITAL_NOTIFICATION_INGEST_KEY") },
        });
        await sleep(1000);
      }
      await publisher.close().catch(() => undefined);
    } catch {
      console.error(JSON.stringify({ level: "error", event: "eda.worker.dependency_unavailable", code: "WORKER_DEPENDENCY_FAILED" }));
    } finally {
      await Promise.allSettled(consumers.map((consumer) => consumer.close()));
      await connection?.close().catch(() => undefined);
    }
    if (!closing) await sleep(5000);
  }
  await databases.close();
}

void run().catch(async () => { console.error(JSON.stringify({ level: "error", event: "eda.worker.failed" }));
  await databases.close(); process.exitCode = 1; });
