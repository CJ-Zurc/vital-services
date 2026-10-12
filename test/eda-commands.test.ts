import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Prisma } from "../src/eda/generated/core/client.js";
import type { ProfileCommandGuard } from "../src/eda/modules/core/profile.js";
import { createProfileCommandGuard } from "../src/eda/modules/core/profile-commands.js";

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
  const { tx, command } = fixture();
  const guard = createProfileCommandGuard();
  let effects = 0;
  const execute = async () => { effects++; return { value: "committed" }; };
  assert.deepEqual(await guard(tx, command, execute), { value: "committed" });
  assert.deepEqual(await guard(tx, command, execute), { value: "committed" });
  assert.equal(effects, 1);
});

test("EDA command guard rejects reused operation IDs with different action resource or body", async () => {
  const { tx, command } = fixture();
  const guard = createProfileCommandGuard();
  await guard(tx, command, async () => ({ value: "committed" }));
  for (const changed of [{ ...command, operation: "materialize" as const },
    { ...command, actor: { ...command.actor, resource: randomUUID() } },
    { ...command, metadata: { ...command.metadata!, requestHash: "b".repeat(64) } }]) {
    await assert.rejects(guard(tx, changed, async () => { assert.fail("conflicting replay must not execute"); }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "COMMAND_REPLAY_CONFLICT");
  }
});

test("EDA command guard blocks missing metadata pending work and unaccepted integration writes", async () => {
  const { tx, command, row } = fixture();
  const guard = createProfileCommandGuard();
  const execute = async () => { assert.fail("denied command must not execute"); };
  await assert.rejects(guard(tx, { ...command, metadata: undefined }, execute));
  await assert.rejects(guard(tx, { ...command, operation: "patient.onboarding" }, execute));
  await assert.rejects(guard(tx, { ...command, operation: "doctor.update", input: { specialty: "Cardiology" } }, execute));
  await guard(tx, command, async () => ({ value: "committed" }));
  row()!.status = "pending";
  await assert.rejects(guard(tx, command, execute));
});
