import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspace = resolve(backend, "..");
const names = ["vital-web", "vital-services", "BGH_API_GATEWAY", "BGH_NOTIFICATION_API", "BGH_AUDIT_LOGS", "BGH_ANALYTICS", "UHSE_AUTH", "Capstone_BGH", "eda-worktrees/UHSE_EHR-current"];
const git = (path, args) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
const repositories = names.map((name) => {
  const path = resolve(workspace, name);
  return { name, path, branch: git(path, ["branch", "--show-current"]), head: git(path, ["rev-parse", "HEAD"]),
    developmentRef: git(path, ["rev-parse", "origin/development"]),
    developmentBaselineIncluded: git(path, ["rev-list", "--count", "HEAD..origin/development"]) === "0" };
});
const authority = "C:/Users/User/Downloads/EDA_TRANSITION_PLAN_REVISED.md";
const plan = await readFile(authority);
await writeFile(resolve(backend, "docs/eda/baseline.json"), JSON.stringify({ recordedAt: new Date().toISOString(),
  authority, authoritySha256: createHash("sha256").update(plan).digest("hex"),
  sharedDeploymentInspected: false, originalDirtyEhrWorktreeExcluded: true, repositories }, null, 2) + "\n");
console.log(`Recorded ${repositories.length} local baseline SHAs; no branches, histories or deployments changed.`);
