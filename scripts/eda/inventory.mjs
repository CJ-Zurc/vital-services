import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const web = resolve(root, "../vital-web");
const ts = createRequire(resolve(root, "package.json"))("typescript");
const routes = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "generated") await walk(path);
    if (!entry.isFile() || entry.name !== "route.ts") continue;
    const text = await readFile(path, "utf8");
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
    const methods = new Set();
    for (const node of ast.statements) {
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const item of node.exportClause.elements) if (httpMethods.has(item.name.text)) methods.add(item.name.text);
      }
      if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (ts.isFunctionDeclaration(node) && node.name && httpMethods.has(node.name.text)) methods.add(node.name.text);
      if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && httpMethods.has(declaration.name.text)) methods.add(declaration.name.text);
      }
    }
    const route = "/" + relative(resolve(web, "app"), dirname(path)).split(/[\\/]/).filter((part) => !part.startsWith("(")).join("/");
    routes.push({ path: route, methods: [...methods].sort(), source: relative(web, path).replaceAll("\\", "/"), sourceSha256: createHash("sha256").update(text).digest("hex"), usesDatabase: /(?:lib\/prisma|generated\/prisma)/.test(text), hasGatewaySession: /requireBffSession|resolveBffSession|readGatewayActor|require.*Actor/.test(text), migrationStatus: "pending_contract_parity",
      contractReview: { caller: null, authentication: null, targetOwner: null, requiredRole: null, requestDto: null,
        responseDto: null, cookies: null, bodyLimit: null, timeout: null, reviewed: false } });
  }
}
await walk(resolve(web, "app"));
const git = (directory) => execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
await mkdir(resolve(root, "docs/eda"), { recursive: true });
await writeFile(resolve(root, "docs/eda/route-baseline.json"), JSON.stringify({ vitalWebSha: git(web), vitalServicesSha: git(root), generatedAt: new Date().toISOString(), routes: routes.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2) + "\n");
console.log(`Recorded ${routes.length} existing route contracts; authentication markers are inventory hints, not verified authorization claims.`);
