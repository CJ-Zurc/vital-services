import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { getDMMF } = require("@prisma/internals");

test("EDA fresh migration histories create each owned model once before Profile additions", async () => {
  for (const domain of ["core", "integrations"]) {
    const base = new URL(`../prisma/${domain}/`, import.meta.url);
    const history = new URL("migrations/", base);
    const directories = readdirSync(history, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => entry.name).sort();
    assert.equal(directories[0], "202610120001_initial");
    const created: string[] = [];
    for (const directory of directories) {
      const sql = readFileSync(new URL(`${directory}/migration.sql`, history), "utf8");
      created.push(...Array.from(sql.matchAll(/CREATE TABLE "([^"]+)"/g), match => match[1]!));
    }
    const { datamodel } = await getDMMF({ datamodel: readFileSync(new URL("schema.prisma", base), "utf8") });
    const expected = datamodel.models.map((model: { dbName: string | null; name: string }) => model.dbName ?? model.name);
    assert.equal(new Set(created).size, created.length, "No table is created by competing migrations.");
    assert.deepEqual(created.sort(), expected.sort(), "Fresh histories include every owned model.");
  }
});
