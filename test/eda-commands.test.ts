import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Prisma } from "../src/eda/generated/core/client.js";
import type { ProfileCommandGuard } from "../src/eda/modules/profile/profile.js";
import { createProfileCommandGuard } from "../src/eda/modules/profile/profile-commands.js";
import { requestHash as canonicalHash } from "../src/eda/infrastructure/security.js";

type Command = Parameters<ProfileCommandGuard>[1];
function fixture() {
  let row: Record<string, unknown> | undefined;
  const tx = { commandOperation: {
    async findUnique() { return row ?? null; },
    async create({ data }: { data: Record<string, unknown> }) { row = { ...data }; return row; },
    async update({ data }: { data: Record<string, unknown> }) { Object.assign(row!, data); return row; },
  } } as unknown as Prisma.TransactionClient;
  const authId = randomUUID();
  const command: Command = { operation: "patient.update", input: {}, metadata: { operationId: randomUUID(), requestHash: "a".repeat(64) },
    actor: { authId, role: "patient", serviceId: "vital-web", resource: authId, scopes: ["profile.write"],
      correlationId: randomUUID(), isSuperAdmin: false } };
  return { tx, command, row: () => row };
}

test("EDA command guard returns the stored result without reexecuting a matching mutation", async () => {
  const { tx, command, row } = fixture();
  const guard = createProfileCommandGuard();
  let effects = 0;
  const execute = async () => { effects++; return { value: "committed" }; };
  assert.deepEqual(await guard(tx, command, execute), { value: "committed" });
  assert.deepEqual(await guard(tx, command, execute), { value: "committed" });
  assert.equal(effects, 1);
  assert.equal(row()!.requestHash, canonicalHash("PROFILE-COMMAND", command.operation, {
    role: command.actor.role, targetAuthId: command.actor.authId, input: command.input,
    transportHash: command.metadata!.requestHash,
  }));
  assert.notEqual(row()!.requestHash, command.metadata!.requestHash);
});

test("EDA command guard rejects reused operation IDs with different action resource or body", async () => {
  const { tx, command } = fixture();
  const guard = createProfileCommandGuard();
  await guard(tx, command, async () => ({ value: "committed" }));
  for (const changed of [{ ...command, operation: "materialize" as const },
    { ...command, input: { emergencyContactName: "Changed" } },
    { ...command, actor: { ...command.actor, role: "doctor" as const } },
    { ...command, metadata: { ...command.metadata!, requestHash: "b".repeat(64) } }]) {
    await assert.rejects(guard(tx, changed, async () => { assert.fail("conflicting replay must not execute"); }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "COMMAND_REPLAY_CONFLICT");
  }
  const resource = randomUUID();
  await assert.rejects(guard(tx, { ...command, actor: { ...command.actor, resource } }, async () => assert.fail()),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ACTOR_SCOPE_DENIED");
  await assert.rejects(guard(tx, { ...command, targetAuthId: resource, actor: { ...command.actor, resource } }, async () => assert.fail()),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "COMMAND_REPLAY_CONFLICT");
});

test("EDA command guard blocks missing metadata and pending work; domain workflows own integration verification", async () => {
  const { tx, command, row } = fixture();
  const guard = createProfileCommandGuard();
  const execute = async () => { assert.fail("denied command must not execute"); };
  await assert.rejects(guard(tx, { ...command, metadata: undefined }, execute));
  await guard(tx, command, async () => ({ value: "committed" }));
  row()!.status = "pending";
  await assert.rejects(guard(tx, command, execute));
  const prepared = fixture();
  assert.deepEqual(await guard(prepared.tx, { ...prepared.command, operation: "workflow.prepare" },
    async () => ({ state: "prepared" })), { state: "prepared" });
});
