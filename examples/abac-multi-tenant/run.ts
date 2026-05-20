/**
 * Offline runner for the abac-multi-tenant example.
 * Usage: npx tsx examples/abac-multi-tenant/run.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleAuthorize } from "../../src/tools/authorize.js";
import { handleValidate } from "../../src/tools/validate.js";
import { handleExplain } from "../../src/tools/explain.js";
import { handleCheckChange } from "../../src/tools/check-change.js";
import { handleGenerateSample } from "../../src/tools/generate-sample.js";

const dir = new URL(".", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(dir, p), "utf8");

const schema = read("schema.json");
const entities = read("entities/users-and-docs.json");

const policies = [
  read("policies/owner-full-access.cedar"),
  read("policies/member-read-internal.cedar"),
  read("policies/premium-share-guard.cedar"),
  read("policies/private-doc-guard.cedar"),
].join("\n\n");

function section(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

// ─── cedar_validate ───────────────────────────────────────────────────────────

section("cedar_validate — all policies against schema");
const vr = await handleValidate({ policies, schema });
console.log(`  valid: ${vr.valid}  |  policies: ${vr.policy_count}`);
if (vr.errors.length) console.log("  errors:", vr.errors);

// ─── cedar_authorize ──────────────────────────────────────────────────────────

section("cedar_authorize — ABAC decisions");
const cases = [
  { label: "alice reads q4-roadmap (owner, internal)", p: 'SaaS::User::"alice"', a: 'SaaS::Action::"READ"', r: 'SaaS::Document::"q4-roadmap"', expected: "Allow" },
  { label: "bob reads q4-roadmap (non-owner, internal)", p: 'SaaS::User::"bob"', a: 'SaaS::Action::"READ"', r: 'SaaS::Document::"q4-roadmap"', expected: "Allow" },
  { label: "charlie reads salary-review (non-owner, private)", p: 'SaaS::User::"charlie"', a: 'SaaS::Action::"READ"', r: 'SaaS::Document::"salary-review"', expected: "Deny" },
  { label: "alice reads salary-review (owner, private)", p: 'SaaS::User::"alice"', a: 'SaaS::Action::"READ"', r: 'SaaS::Document::"salary-review"', expected: "Allow" },
  { label: "charlie shares public-changelog (free plan)", p: 'SaaS::User::"charlie"', a: 'SaaS::Action::"SHARE"', r: 'SaaS::Document::"public-changelog"', expected: "Deny" },
  { label: "bob shares public-changelog (pro plan)", p: 'SaaS::User::"bob"', a: 'SaaS::Action::"SHARE"', r: 'SaaS::Document::"public-changelog"', expected: "Allow" },
];

for (const c of cases) {
  const r = await handleAuthorize({ policies, principal: c.p, action: c.a, resource: c.r, entities, schema });
  const pass = r.decision === c.expected ? "✓" : "✗";
  console.log(`  ${pass} ${c.label}: ${r.decision}`);
}

// ─── cedar_explain ────────────────────────────────────────────────────────────

section("cedar_explain — premium-share-guard");
const er = await handleExplain({ policy: read("policies/premium-share-guard.cedar") });
console.log(`  summary: ${er.summary}`);
console.log(`  patterns: ${er.patterns_detected.join(", ")}`);
console.log(`  conditions:`);
for (const c of er.conditions) console.log(`    [${c.kind}] ${c.text}`);

// ─── cedar_generate_sample_request ───────────────────────────────────────────

section("cedar_generate_sample_request — deny for member-read-internal");
const gr = await handleGenerateSample({
  policy: read("policies/member-read-internal.cedar"),
  schema,
  target_decision: "deny",
});
console.log(`  decision: ${gr.decision}`);
console.log(`  resource attrs: ${JSON.stringify(gr.entities.find(e => e.uid.type.includes("Document"))?.attrs)}`);
console.log(`  explanation: ${gr.explanation}`);

// ─── cedar_check_policy_change ────────────────────────────────────────────────

section("cedar_check_policy_change — owner check vs role check");
const cr = await handleCheckChange({
  old_policy: `permit(principal, action, resource) when { principal.name == resource.owner_id };`,
  new_policy: `permit(principal in SaaS::Role::"editor", action, resource);`,
});
console.log(`  can_update_in_place: ${cr.can_update_in_place}`);
for (const c of cr.changes) {
  console.log(`  field=${c.field}  in_place_allowed=${c.in_place_allowed}`);
}
console.log(`  recommendation: ${cr.recommendation}`);

console.log("\n✓ All done.");
