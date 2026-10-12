import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import amqp, { type ConfirmChannel, type ChannelModel, type ConsumeMessage, type Message } from "amqplib";
import { z } from "zod";
import { exchangeFor, parseEvent, type EventEnvelope, type EventType, type Producer } from "../contracts/events.js";

export const subscriptions = [
  { id: "appointment-payment", producer: "payment", types: ["vital.payment.completed", "vital.payment.changed"] },
  { id: "platform-audit", producer: "*", types: ["vital.audit.requested"] },
  { id: "platform-notification", producer: "appointment", types: ["vital.notification.requested"] },
  { id: "profile-projection", producer: "profile", types: ["vital.profile.changed"] },
] as const;
const producers: Producer[] = ["profile", "appointment", "payment", "records", "messaging", "video"];

export function validateBrokerUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "amqps:" || decodeURIComponent(url.pathname) !== "/vital" || !url.username ||
      !url.password || decodeURIComponent(url.username) === "guest") throw new Error("Dedicated VITAL AMQPS vhost and non-guest credentials are required.");
}

export async function connectBroker(url: string, caFile: string) {
  validateBrokerUrl(url);
  if (!caFile) throw new Error("Broker CA trust must be configured.");
  return amqp.connect(url, { ca: [readFileSync(caFile)], rejectUnauthorized: true, timeout: 5000 });
}

export function publishConfirmed(channel: ConfirmChannel, exchange: string, routingKey: string, event: EventEnvelope,
  headers: Record<string, unknown> = {}, timeoutMs = 5000): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(parseEvent(event)));
  return publishBytesConfirmed(channel, exchange, routingKey, bytes, "application/json",
    { ...headers, "vital-event-id": event.eventId }, event.correlationId, timeoutMs);
}

export function publishBytesConfirmed(channel: ConfirmChannel, exchange: string, routingKey: string, bytes: Buffer,
  contentType: string, headers: Record<string, unknown> = {}, correlationId?: string, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const transportId = randomUUID();
    const onReturn = (message: Message) => { if (message.properties.messageId === transportId) settle(new Error("UNROUTABLE_EVENT")); };
    const onClose = () => settle(new Error("BROKER_CHANNEL_CLOSED"));
    const onError = () => settle(new Error("BROKER_CHANNEL_ERROR"));
    let settled = false;
    const timer = setTimeout(() => settle(new Error("PUBLISH_CONFIRM_TIMEOUT")), timeoutMs);
    function settle(error?: Error | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.off("return", onReturn); channel.off("close", onClose); channel.off("error", onError);
      if (error) reject(error); else resolve();
    }
    channel.on("return", onReturn); channel.once("close", onClose); channel.once("error", onError);
    try {
      channel.publish(exchange, routingKey, bytes, { persistent: true, mandatory: true, contentType,
        messageId: transportId, correlationId, headers }, (error) => settle(error));
    } catch { settle(new Error("BROKER_PUBLISH_FAILED")); }
  });
}

export async function provisionTopology(connection: ChannelModel) {
  const channel = await connection.createChannel();
  try {
    for (const producer of producers) await channel.assertExchange(exchangeFor(producer), "topic", { durable: true });
    await channel.assertExchange("vital.retry", "direct", { durable: true });
    await channel.assertExchange("vital.dead", "direct", { durable: true });
    await channel.assertExchange("vital.resume", "direct", { durable: true });
    for (const subscription of subscriptions) {
      const queue = `vital.${subscription.id}`;
      await channel.assertQueue(queue, { durable: true, arguments: { "x-queue-type": "quorum", "x-quorum-initial-group-size": 1,
        "x-overflow": "reject-publish", "x-max-length": 5000, "x-max-length-bytes": 16_777_216 } });
      const sourceProducers = subscription.producer === "*" ? producers : [subscription.producer];
      for (const producer of sourceProducers) for (const type of subscription.types) await channel.bindQueue(queue, exchangeFor(producer), type);
      await channel.bindQueue(queue, "vital.resume", subscription.id);
      for (const delay of [60_000, 300_000, 900_000]) {
        const retryQueue = `${queue}.retry.${delay}`;
        await channel.assertQueue(retryQueue, { durable: true, arguments: { "x-queue-type": "quorum", "x-quorum-initial-group-size": 1,
          "x-message-ttl": delay, "x-dead-letter-exchange": "vital.resume", "x-dead-letter-routing-key": subscription.id,
          "x-dead-letter-strategy": "at-least-once", "x-overflow": "reject-publish", "x-max-length": 5000, "x-max-length-bytes": 16_777_216 } });
        await channel.bindQueue(retryQueue, "vital.retry", `${subscription.id}.${delay}`);
      }
      const dlq = `${queue}.dead`;
      await channel.assertQueue(dlq, { durable: true, arguments: { "x-queue-type": "quorum", "x-quorum-initial-group-size": 1,
        "x-overflow": "reject-publish", "x-max-length": 5000, "x-max-length-bytes": 16_777_216 } });
      await channel.bindQueue(dlq, "vital.dead", subscription.id);
    }
  } finally { await channel.close(); }
}

export async function consumeEvents(connection: ChannelModel, subscriptionId: string,
  handler: (event: EventEnvelope) => Promise<void>) {
  const subscription = subscriptions.find((item) => item.id === subscriptionId);
  if (!subscription) throw new Error("Unknown consumer.");
  const consumer = await connection.createChannel();
  const retryPublisher = await connection.createConfirmChannel();
  await consumer.prefetch(2);
  const pending = new Set<Promise<void>>();
  let failed = false;
  const handle = async (message: ConsumeMessage) => {
    let event: EventEnvelope;
    try {
      if (message.content.length > 16_384) throw new Error("EVENT_TOO_LARGE");
      event = parseEvent(JSON.parse(message.content.toString("utf8")));
      if (!(subscription.types as readonly EventType[]).includes(event.eventType) ||
          (subscription.producer !== "*" && subscription.producer !== event.producer) ||
          message.fields.exchange !== exchangeFor(event.producer) && message.fields.exchange !== "vital.resume") throw new Error("INVALID_EVENT_ROUTE");
    } catch {
      // Quarantine without retaining an untrusted body that could contain clinical content.
      const id = z.uuid().safeParse(message.properties.headers?.["vital-event-id"]);
      const quarantine = Buffer.from(JSON.stringify({ code: "INVALID_EVENT", bytes: message.content.length,
        ...(id.success ? { eventId: id.data } : {}) }));
      await publishBytesConfirmed(retryPublisher, "vital.dead", subscriptionId, quarantine, "application/json");
      consumer.ack(message);
      return;
    }
    try { await handler(event); consumer.ack(message); }
    catch {
      const rawAttempt = message.properties.headers?.["vital-attempt"];
      const attempt = typeof rawAttempt === "number" && Number.isInteger(rawAttempt) && rawAttempt >= 0 ? rawAttempt : 0;
      const delay = [60_000, 300_000, 900_000][Math.min(attempt, 2)]!;
      await publishConfirmed(retryPublisher, attempt >= 9 ? "vital.dead" : "vital.retry",
        attempt >= 9 ? subscriptionId : `${subscriptionId}.${delay}`, event, { "vital-attempt": attempt + 1 });
      consumer.ack(message);
    }
  };
  consumer.on("error", () => { failed = true; });
  retryPublisher.on("error", () => { failed = true; });
  const { consumerTag } = await consumer.consume(`vital.${subscriptionId}`, (message) => {
    if (!message) { failed = true; return; }
    const task = handle(message).catch(async () => {
      failed = true;
      // Closing leaves unacknowledged source work available for recovery.
      await consumer.close().catch(() => undefined);
    }).finally(() => pending.delete(task));
    pending.add(task);
  }, { noAck: false });
  return {
    healthy: () => !failed,
    async close() { await consumer.cancel(consumerTag).catch(() => undefined); await Promise.allSettled([...pending]);
      await consumer.close().catch(() => undefined); await retryPublisher.close().catch(() => undefined); },
  };
}
