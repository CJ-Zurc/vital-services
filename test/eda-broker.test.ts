import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ConfirmChannel, Message, ChannelModel } from "amqplib";
import { consumeEvents, provisionTopology, publishConfirmed, publishBytesConfirmed, validateBrokerUrl } from "../src/eda/infrastructure/broker.js";
import { makeEvent } from "../src/eda/infrastructure/outbox.js";

type Callback = (error: Error | null) => void;
function channelStub(behavior: (emitter: EventEmitter, options: Record<string, unknown>, confirm: Callback) => void) {
  const emitter = new EventEmitter();
  const channel = Object.assign(emitter, {
    publish(_exchange: string, _key: string, _bytes: Buffer, options: Record<string, unknown>, confirm: Callback) {
      assert.equal(options.persistent, true);
      assert.equal(options.mandatory, true);
      queueMicrotask(() => behavior(emitter, options, confirm));
      return true;
    },
  });
  return { channel: channel as unknown as ConfirmChannel, emitter };
}
const event = () => makeEvent({ producer: "profile", eventType: "vital.profile.changed", aggregateId: randomUUID(),
  aggregateVersion: 1, correlationId: randomUUID(), data: { authId: randomUUID(), role: "patient", operation: "materialized" } });

test("EDA broker confirms require routing success even when RabbitMQ ACKs publication", async () => {
  const { channel, emitter } = channelStub((bus, options, confirm) => {
    bus.emit("return", { properties: { messageId: options.messageId } } as Message);
    confirm(null);
  });
  await assert.rejects(publishConfirmed(channel, "vital.profile.events", "vital.profile.changed", event()), /UNROUTABLE_EVENT/);
  assert.equal(emitter.listenerCount("return"), 0);
  assert.equal(emitter.listenerCount("close"), 0);
});

test("EDA broker confirms reject NACK, channel loss and bounded confirmation timeout", async () => {
  for (const behavior of [(_bus: EventEmitter, _options: Record<string, unknown>, confirm: Callback) => confirm(new Error("NACK")),
    (bus: EventEmitter) => { bus.emit("close"); }, () => undefined]) {
    const { channel, emitter } = channelStub(behavior);
    await assert.rejects(publishConfirmed(channel, "vital.profile.events", "vital.profile.changed", event(), {}, 10));
    assert.equal(emitter.listenerCount("return"), 0);
    assert.equal(emitter.listenerCount("error"), 0);
  }
});

test("EDA poison quarantine uses mandatory confirms and ignores unrelated returns", async () => {
  const { channel, emitter } = channelStub((bus, _options, confirm) => {
    bus.emit("return", { properties: { messageId: "other-publication" } } as Message);
    confirm(null);
  });
  await publishBytesConfirmed(channel, "vital.dead", "platform-audit", Buffer.from('{"code":"INVALID_EVENT"}'), "application/json");
  assert.equal(emitter.listenerCount("return"), 0);
  const unroutable = channelStub((bus, options, confirm) => {
    bus.emit("return", { properties: { messageId: options.messageId } } as Message); confirm(null);
  });
  await assert.rejects(publishBytesConfirmed(unroutable.channel, "vital.dead", "platform-audit", Buffer.from("{}"), "application/json"));
});

test("EDA broker trust rejects plaintext, shared vhosts and guest identities", () => {
  validateBrokerUrl("amqps://vital_worker:example@vital-rabbitmq:5671/vital");
  for (const url of ["amqp://worker:p@broker/vital", "amqps://guest:p@broker/vital", "amqps://%67uest:p@broker/vital",
    "amqps://worker:p@broker/%2F", "amqps://worker@broker/vital"]) assert.throws(() => validateBrokerUrl(url));
});

test("EDA retry topology resumes through a private named exchange without default-exchange permissions", async () => {
  const queues: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const bindings: Array<[string, string, string]> = [];
  const exchanges: string[] = [];
  const connection = { async createChannel() { return {
    async assertExchange(name: string) { exchanges.push(name); },
    async assertQueue(name: string, options: { arguments: Record<string, unknown> }) { queues.push({ name, arguments: options.arguments }); },
    async bindQueue(queue: string, exchange: string, key: string) { bindings.push([queue, exchange, key]); },
    async close() {},
  }; } } as unknown as ChannelModel;
  await provisionTopology(connection);
  assert.ok(exchanges.includes("vital.resume"));
  const retries = queues.filter((queue) => queue.name.includes(".retry."));
  assert.equal(retries.length, 42);
  assert.ok(bindings.some(([queue, exchange, key]) => queue === 'vital.messaging-state' && exchange === 'vital.messaging.events' && key === 'vital.messaging.changed'));
  assert.ok(bindings.some(([queue, exchange, key]) => queue === 'vital.video-workflow' && exchange === 'vital.appointment.events' && key === 'vital.video.workflow.finalization.requested'));
  assert.ok(bindings.some(([queue, exchange, key]) => queue === 'vital.video-state' && exchange === 'vital.video.events' && key === 'vital.video.generation.changed'));
  assert.ok(bindings.some(([queue, exchange, key]) => queue === "vital.records-artifact" && exchange === "vital.records.events" && key === "vital.records.artifact.requested"));
  assert.ok(bindings.some(([queue, exchange, key]) => queue === "vital.appointment-confirmation" && exchange === "vital.payment.events" && key === "vital.payment.completed"));
  for (const queue of retries) {
    assert.equal(queue.arguments["x-dead-letter-exchange"], "vital.resume");
    assert.equal(queue.arguments["x-dead-letter-strategy"], "at-least-once");
    assert.equal(queue.arguments["x-queue-type"], "quorum");
    assert.ok(Number(queue.arguments["x-max-length-bytes"]) > 0);
    assert.ok(bindings.some(([name, exchange, key]) => name === queue.name.split(".retry.")[0] &&
      exchange === "vital.resume" && key === queue.arguments["x-dead-letter-routing-key"]));
  }
});

test("EDA consumer and retry channel closure mark the worker unhealthy for recovery", async () => {
  for (const closed of ["consumer", "publisher"]) {
    const consumer = Object.assign(new EventEmitter(), { async prefetch() {}, async consume() { return { consumerTag: "test" }; },
      async cancel() {}, async close() {} });
    const publisher = Object.assign(new EventEmitter(), { async close() {} });
    const connection = { async createChannel() { return consumer; }, async createConfirmChannel() { return publisher; } } as unknown as ChannelModel;
    const subscription = await consumeEvents(connection, "profile-sync", async () => {});
    assert.equal(subscription.healthy(), true);
    (closed === "consumer" ? consumer : publisher).emit("close");
    assert.equal(subscription.healthy(), false);
    await subscription.close();
  }
});
