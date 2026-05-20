/**
 * Offline runner for the api-gateway-path-routing example.
 * Usage: npx tsx examples/api-gateway-path-routing/run.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleAuthorize } from "../../src/tools/authorize.js";
import { handleValidate } from "../../src/tools/validate.js";
import { handleExplain } from "../../src/tools/explain.js";
import { handleGenerateSample } from "../../src/tools/generate-sample.js";

const dir = new URL(".", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(dir, p), "utf8");

const schema = read("schema.json");
const entities = read("entities/users-and-roles.json");

const policies = [
  read("policies/admin-full-access.cedar"),
  read("policies/developer-projects.cedar"),
  read("policies/viewer-readonly.cedar"),
].join("\n\n");

function section(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

// Helper: build an endpoint entity on the fly for a given path + method
function withEndpoint(path: string, method: string) {
  const base = JSON.parse(entities) as unknown[];
  base.push({
    uid: { type: "API::Endpoint", id: "req" },
    attrs: { path, method },
    parents: [],
  });
  return JSON.stringify(base);
}

// ─── cedar_validate ───────────────────────────────────────────────────────────

section("cedar_validate — all policies against schema");
const vr = await handleValidate({ policies, schema });
console.log(`  valid: ${vr.valid}  |  policies: ${vr.policy_count}`);

// ─── cedar_authorize — path depth tests ───────────────────────────────────────

section("cedar_authorize — path-depth routing decisions");

const routeCases = [
  { label: "bob GET /api/v1/projects (collection)", user: "bob", action: "GET", path: "/api/v1/projects", expected: "Allow" },
  { label: "bob POST /api/v1/projects/proj-1 (one level deep)", user: "bob", action: "POST", path: "/api/v1/projects/proj-1", expected: "Allow" },
  { label: "bob GET /api/v1/projects/proj-1/tasks (two levels — blocked)", user: "bob", action: "GET", path: "/api/v1/projects/proj-1/tasks", expected: "Deny" },
  { label: "bob DELETE /api/v1/projects (DELETE not permitted)", user: "bob", action: "DELETE", path: "/api/v1/projects", expected: "Deny" },
  { label: "charlie GET /api/v1/projects/proj-1 (viewer, one level)", user: "charlie", action: "GET", path: "/api/v1/projects/proj-1", expected: "Allow" },
  { label: "charlie GET /api/v1/projects/proj-1/tasks (viewer, no depth limit — allowed)", user: "charlie", action: "GET", path: "/api/v1/projects/proj-1/tasks", expected: "Allow" },
  { label: "alice DELETE /api/v1/projects/proj-1 (admin, anything)", user: "alice", action: "DELETE", path: "/api/v1/projects/proj-1", expected: "Allow" },
];

for (const c of routeCases) {
  const ents = withEndpoint(c.path, c.action);
  const r = await handleAuthorize({
    policies,
    principal: `API::User::"${c.user}"`,
    action: `API::Action::"${c.action}"`,
    resource: 'API::Endpoint::"req"',
    entities: ents,
    schema,
  });
  const pass = r.decision === c.expected ? "✓" : "✗";
  console.log(`  ${pass} ${c.label}: ${r.decision}`);
}

// ─── cedar_explain ────────────────────────────────────────────────────────────

section("cedar_explain — developer-projects (path-matching + depth limit)");
const er = await handleExplain({ policy: read("policies/developer-projects.cedar") });
console.log(`  summary: ${er.summary}`);
console.log(`  conditions:`);
for (const c of er.conditions) console.log(`    [${c.kind}] ${c.text}`);

// ─── cedar_generate_sample_request ───────────────────────────────────────────

section("cedar_generate_sample_request — allow path for developer-projects");
const allowSample = await handleGenerateSample({
  policy: read("policies/developer-projects.cedar"),
  schema,
  target_decision: "allow",
});
console.log(`  decision: ${allowSample.decision}`);
const ep = allowSample.entities.find(e => e.uid.type.includes("Endpoint"));
console.log(`  generated path: ${ep?.attrs?.path}`);
console.log(`  explanation: ${allowSample.explanation}`);

section("cedar_generate_sample_request — deny path (too deep)");
const denySample = await handleGenerateSample({
  policy: read("policies/developer-projects.cedar"),
  schema,
  target_decision: "deny",
});
console.log(`  decision: ${denySample.decision}`);
const ep2 = denySample.entities.find(e => e.uid.type.includes("Endpoint"));
console.log(`  generated path: ${ep2?.attrs?.path}`);
console.log(`  explanation: ${denySample.explanation}`);

console.log("\n✓ All done.");
