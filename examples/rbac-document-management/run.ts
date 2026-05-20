/**
 * Offline runner for the rbac-document-management example.
 * Runs each cedar-mcp-server tool against the example files and prints results.
 *
 * Usage: npx tsx examples/rbac-document-management/run.ts
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
const entities = read("entities/users-and-docs.json");

const policies = [
  read("policies/admin.cedar"),
  read("policies/editor.cedar"),
  read("policies/viewer.cedar"),
  read("policies/top-secret-forbid.cedar"),
].join("\n\n");

function section(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

// ─── cedar_validate ───────────────────────────────────────────────────────────

section("cedar_validate — all policies against schema");
const validateResult = await handleValidate({ policies, schema });
console.log(`  valid: ${validateResult.valid}`);
console.log(`  policies: ${validateResult.policy_count}`);
if (validateResult.errors.length > 0) {
  console.log("  errors:", validateResult.errors);
}

// ─── cedar_authorize ──────────────────────────────────────────────────────────

section("cedar_authorize — 4 representative decisions");
const authCases = [
  { label: "alice (admin) reads acquisition-details", principal: 'DocMgmt::User::"alice"', action: 'DocMgmt::Action::"READ"', resource: 'DocMgmt::Document::"acquisition-details"', expected: "Allow" },
  { label: "bob (editor) writes roadmap-2026", principal: 'DocMgmt::User::"bob"', action: 'DocMgmt::Action::"WRITE"', resource: 'DocMgmt::Document::"roadmap-2026"', expected: "Allow" },
  { label: "bob (editor) reads acquisition-details (top_secret forbid)", principal: 'DocMgmt::User::"bob"', action: 'DocMgmt::Action::"READ"', resource: 'DocMgmt::Document::"acquisition-details"', expected: "Deny" },
  { label: "dave (no role) reads public-announcement (default deny)", principal: 'DocMgmt::User::"dave"', action: 'DocMgmt::Action::"READ"', resource: 'DocMgmt::Document::"public-announcement"', expected: "Deny" },
];

for (const c of authCases) {
  const r = await handleAuthorize({ policies, principal: c.principal, action: c.action, resource: c.resource, entities, schema });
  const pass = r.decision === c.expected ? "✓" : "✗";
  console.log(`  ${pass} ${c.label}: ${r.decision}`);
  if (r.determining_policies.length > 0) console.log(`    determined by: ${r.determining_policies.join(", ")}`);
}

// ─── cedar_explain ────────────────────────────────────────────────────────────

section("cedar_explain — editor policy");
const explainResult = await handleExplain({ policy: read("policies/top-secret-forbid.cedar") });
console.log(`  effect: ${explainResult.effect}`);
console.log(`  summary: ${explainResult.summary}`);
console.log(`  patterns: ${explainResult.patterns_detected.join(", ")}`);
console.log(`  conditions:`);
for (const c of explainResult.conditions) {
  console.log(`    [${c.kind}] ${c.text}`);
}

// ─── cedar_generate_sample_request ───────────────────────────────────────────

section("cedar_generate_sample_request — allow request for editor policy");
const sampleResult = await handleGenerateSample({
  policy: read("policies/editor.cedar"),
  schema,
  target_decision: "allow",
});
console.log(`  decision: ${sampleResult.decision}`);
console.log(`  principal: ${sampleResult.principal}`);
console.log(`  action: ${sampleResult.action}`);
console.log(`  resource: ${sampleResult.resource}`);
console.log(`  explanation: ${sampleResult.explanation}`);

console.log("\n✓ All done.");
