import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAdvise } from "../../src/tools/advise.js";
import { StoreManager } from "../../src/resources/store-manager.js";

// ─── Fixture data (Dataset 1: DocMgmt, NDA-safe) ──────────────────────────────

const SCHEMA_CEDARSCHEMA = `namespace DocMgmt {
  entity User in [Role] = { name: String, email: String };
  entity Role;
  entity Document = { classification: String, business_unit: String };
  action READ appliesTo { principal: [User], resource: [Document], context: {} };
  action WRITE appliesTo { principal: [User], resource: [Document], context: {} };
}`;

const SCHEMA_JSON = JSON.stringify({
  DocMgmt: {
    entityTypes: {
      User: { memberOfTypes: ["Role"], shape: { type: "Record", attributes: { name: { type: "String", required: true } } } },
      Role: { shape: { type: "Record", attributes: {} }, memberOfTypes: [] },
      Document: { shape: { type: "Record", attributes: { classification: { type: "String", required: true } } } },
    },
    actions: {
      READ: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Document"], context: { type: "Record", attributes: {} } } },
      WRITE: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Document"], context: { type: "Record", attributes: {} } } },
    },
  },
});

const ADMIN_POLICY = `permit(principal in DocMgmt::Role::"admin", action, resource);`;
const EDITOR_POLICY = `permit(principal in DocMgmt::Role::"editor", action == DocMgmt::Action::"READ", resource);`;
const REBAC_POLICY = `permit(principal is DocMgmt::User, action == DocMgmt::Action::"READ", resource is DocMgmt::Document) when { principal in resource.owners };`;

function makeStore(baseDir: string, name: string, policies: Record<string, string>, schema = SCHEMA_CEDARSCHEMA, schemaFile = "schema.cedarschema"): string {
  const path = join(baseDir, name);
  mkdirSync(join(path, "policies"), { recursive: true });
  for (const [id, content] of Object.entries(policies)) {
    writeFileSync(join(path, "policies", `${id}.cedar`), content);
  }
  writeFileSync(join(path, schemaFile), schema);
  return path;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("cedar_advise — context preparator (v2, no sampling)", () => {
  let tmpDir: string;
  let manager: StoreManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cedar-advise-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    manager = new StoreManager();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Pivot guarantees: no sampler, deterministic, synchronous-shaped ────────

  it("B1 — handleAdvise is a pure function: no sampler argument, no async LLM call", () => {
    // The signature accepts (input, manager?) — no sampler. Calling it returns a value
    // synchronously without awaiting any client LLM round-trip.
    const result = handleAdvise({ intent: "test" });
    expect(result).toBeDefined();
    expect(result.tool).toBe("cedar_advise");
    expect(result.bundle_version).toBe("v2");
  });

  it("B2 — deterministic: two calls with identical inputs return identical bundles", () => {
    const a = handleAdvise({ intent: "Restrict read to verified email users" });
    const b = handleAdvise({ intent: "Restrict read to verified email users" });
    expect(a).toEqual(b);
  });

  // ─── Bundle universal payload (independent of store_ref) ────────────────────

  it("B3 — bundle echoes intent verbatim", () => {
    const intent = "Only admins should delete top-secret documents";
    const result = handleAdvise({ intent });
    expect(result.intent).toBe(intent);
  });

  it("B4 — bundle includes Cedar patterns reference with all four patterns", () => {
    const result = handleAdvise({ intent: "anything" });
    const names = result.cedar_patterns_reference.patterns.map(p => p.name);
    expect(names).toEqual(expect.arrayContaining([
      expect.stringMatching(/Membership/),
      expect.stringMatching(/Relationship/),
      expect.stringMatching(/Discretionary/),
      expect.stringMatching(/Hybrid/),
    ]));
    expect(result.cedar_patterns_reference.summary).toContain("MEMBERSHIP");
  });

  it("B5 — bundle includes AVP UpdatePolicy rules with three buckets", () => {
    const result = handleAdvise({ intent: "anything" });
    expect(result.avp_update_policy_rules.in_place_via_update_policy.length).toBeGreaterThan(0);
    expect(result.avp_update_policy_rules.requires_delete_recreate.length).toBeGreaterThan(0);
    expect(result.avp_update_policy_rules.new_via_create_policy.length).toBeGreaterThan(0);
    expect(result.avp_update_policy_rules.summary).toContain("UpdatePolicy");
  });

  it("B6 — bundle includes AVP validation error catalog", () => {
    const result = handleAdvise({ intent: "anything" });
    const ids = result.avp_validation_error_catalog.map(e => e.id);
    expect(ids).toContain("UnsafeOptionalAttributeAccess");
    expect(ids).toContain("UnrecognizedEntityType");
    expect(ids).toContain("MissingAttribute");
  });

  it("B7 — bundle includes sequencing_guidance with schema-before-policy rule", () => {
    const result = handleAdvise({ intent: "anything" });
    expect(result.sequencing_guidance.length).toBeGreaterThan(0);
    const joined = result.sequencing_guidance.join(" ");
    expect(joined).toMatch(/schema.*before.*polic/i);
  });

  it("B8 — bundle includes next_steps_for_llm directing follow-up tool calls", () => {
    const result = handleAdvise({ intent: "anything" });
    expect(result.next_steps_for_llm).toContain("cedar_validate");
    expect(result.next_steps_for_llm).toContain("cedar_check_policy_change");
  });

  // ─── Gotcha selection from intent keywords ───────────────────────────────────

  it("B9 — selects optional_attribute_guard gotcha for verified-email intent", () => {
    const result = handleAdvise({
      intent: "Require verified email attribute before granting read access",
    });
    const ids = result.applicable_gotchas.map(g => g.id);
    expect(ids).toContain("optional_attribute_guard");
  });

  it("B10 — selects forbid_overrides_permit gotcha for block/deny intent", () => {
    const result = handleAdvise({
      intent: "Block all access to sensitive top-secret documents except admins",
    });
    const ids = result.applicable_gotchas.map(g => g.id);
    expect(ids).toContain("forbid_overrides_permit");
  });

  it("B11 — selects rebac_migration_data gotcha for relationship/owners intent", () => {
    const result = handleAdvise({
      intent: "Migrate to per-resource owner-based access (owners attribute on Document)",
    });
    const ids = result.applicable_gotchas.map(g => g.id);
    expect(ids).toContain("rebac_migration_data");
  });

  it("B12 — no gotcha keywords matched: applicable_gotchas is empty but bundle still valid", () => {
    const result = handleAdvise({ intent: "xyzzy plugh frobnitz" });
    expect(result.applicable_gotchas).toEqual([]);
    // Universal sections still populated
    expect(result.cedar_patterns_reference.patterns.length).toBeGreaterThan(0);
    expect(result.avp_update_policy_rules.in_place_via_update_policy.length).toBeGreaterThan(0);
  });

  // ─── Store context handling ─────────────────────────────────────────────────

  it("B13 — store_ref omitted: store_status='not_provided', no schema, empty inventory", () => {
    const result = handleAdvise({ intent: "anything" });
    expect(result.store_status).toBe("not_provided");
    expect(result.store_name).toBeUndefined();
    expect(result.schema_summary).toBeUndefined();
    expect(result.policy_inventory).toEqual([]);
    expect(result.patterns_detected_in_store).toEqual([]);
  });

  it("B14 — store_ref unknown: store_status='not_found', store_name preserved", () => {
    const result = handleAdvise({ intent: "anything", store_ref: "nonexistent" }, manager);
    expect(result.store_status).toBe("not_found");
    expect(result.store_name).toBe("nonexistent");
    expect(result.schema_summary).toBeUndefined();
    expect(result.policy_inventory).toEqual([]);
  });

  it("B15 — store_ref loaded: bundle includes schema_summary, inventory, pattern counts", () => {
    const storePath = makeStore(tmpDir, "mystore", { admin: ADMIN_POLICY, editor: EDITOR_POLICY });
    manager.loadFromRoots([{ uri: `file://${storePath}`, name: "mystore" }]);

    const result = handleAdvise({ intent: "Add ABAC condition", store_ref: "mystore" }, manager);

    expect(result.store_status).toBe("loaded");
    expect(result.store_name).toBe("mystore");
    expect(result.schema_summary?.valid).toBe(true);
    expect(result.schema_summary?.format).toBe("cedarschema");
    expect(result.schema_summary?.namespaces).toContain("DocMgmt");
    expect(result.policy_inventory).toHaveLength(2);
    expect(result.policy_inventory.map(p => p.policy_id).sort()).toEqual(["admin", "editor"]);
    // Both admin and editor use principal-in-Role → Membership pattern
    const membershipCount = result.patterns_detected_in_store.find(p => p.pattern === "membership")?.count;
    expect(membershipCount).toBe(2);
  });

  it("B16 — store_ref accepts cedar:// URI form", () => {
    const storePath = makeStore(tmpDir, "production", { admin: ADMIN_POLICY });
    manager.loadFromRoots([{ uri: `file://${storePath}`, name: "production" }]);

    const result = handleAdvise(
      { intent: "Update policy", store_ref: "cedar://policies/production" },
      manager
    );

    expect(result.store_status).toBe("loaded");
    expect(result.store_name).toBe("production");
  });

  it("B17 — policy_inventory entries include full Cedar text so the LLM can quote exact scope", () => {
    const storePath = makeStore(tmpDir, "withtext", { admin: ADMIN_POLICY, editor: EDITOR_POLICY });
    manager.loadFromRoots([{ uri: `file://${storePath}`, name: "withtext" }]);

    const result = handleAdvise({ intent: "Modify editor permissions", store_ref: "withtext" }, manager);

    const editor = result.policy_inventory.find(p => p.policy_id === "editor");
    expect(editor).toBeDefined();
    expect(editor!.policy_text).toContain('Role::"editor"');
    expect(editor!.policy_text).toContain('Action::"READ"');
  });

  it("B18 — ReBAC policy classified as relationship pattern in patterns_detected_in_store", () => {
    const storePath = makeStore(tmpDir, "rebac", { owner: REBAC_POLICY });
    manager.loadFromRoots([{ uri: `file://${storePath}`, name: "rebac" }]);

    const result = handleAdvise({ intent: "Audit ReBAC policies", store_ref: "rebac" }, manager);

    const relationshipCount = result.patterns_detected_in_store.find(p => p.pattern === "relationship")?.count;
    expect(relationshipCount).toBe(1);
  });

  it("B19 — JSON-format schema parsed and summarized correctly", () => {
    const storePath = makeStore(tmpDir, "jsonstore", { admin: ADMIN_POLICY }, SCHEMA_JSON, "schema.json");
    manager.loadFromRoots([{ uri: `file://${storePath}`, name: "jsonstore" }]);

    const result = handleAdvise({ intent: "anything", store_ref: "jsonstore" }, manager);

    expect(result.schema_summary?.valid).toBe(true);
    expect(result.schema_summary?.format).toBe("json");
    expect(result.schema_summary?.namespaces).toEqual(["DocMgmt"]);
    expect(result.schema_summary?.entity_type_count).toBe(3);
    expect(result.schema_summary?.action_count).toBe(2);
  });

  // ─── MCP tool description contract (for the bypass-prevention case) ─────────

  it("B20 — bundle is self-describing: tool name + version + intent recorded for downstream auditing", () => {
    const result = handleAdvise({ intent: "Add a deletion permission" });
    expect(result.tool).toBe("cedar_advise");
    expect(result.bundle_version).toBe("v2");
    expect(result.intent).toBe("Add a deletion permission");
  });
});
