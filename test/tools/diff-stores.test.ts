import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDiffStores } from "../../src/tools/diff-stores.js";
import { StoreManager } from "../../src/resources/store-manager.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const SCHEMA_TEXT = `namespace DocMgmt {
  entity User in [Role] = { name: String };
  entity Role;
  entity Document = { classification: String };
  action READ appliesTo { principal: [User], resource: [Document], context: {} };
  action WRITE appliesTo { principal: [User], resource: [Document], context: {} };
  action DELETE appliesTo { principal: [User], resource: [Document], context: {} };
}`;

function makeStore(
  baseDir: string,
  name: string,
  policies: Record<string, string>,
  schema = SCHEMA_TEXT
): string {
  const path = join(baseDir, name);
  mkdirSync(join(path, "policies"), { recursive: true });
  for (const [id, content] of Object.entries(policies)) {
    writeFileSync(join(path, "policies", `${id}.cedar`), content);
  }
  writeFileSync(join(path, "schema.cedarschema"), schema);
  return path;
}

const ADMIN_POLICY = `permit(principal in DocMgmt::Role::"admin", action, resource);`;
const EDITOR_POLICY_V1 = `permit(principal in DocMgmt::Role::"editor", action in [DocMgmt::Action::"READ", DocMgmt::Action::"WRITE"], resource);`;
const EDITOR_POLICY_V2_CONDITION_CHANGE = `permit(principal in DocMgmt::Role::"editor", action in [DocMgmt::Action::"READ", DocMgmt::Action::"WRITE"], resource) when { resource.classification != "top_secret" };`;
const EDITOR_POLICY_V3_PRINCIPAL_CHANGE = `permit(principal in DocMgmt::Role::"senior_editor", action in [DocMgmt::Action::"READ", DocMgmt::Action::"WRITE"], resource);`;
const VIEWER_POLICY = `permit(principal in DocMgmt::Role::"viewer", action == DocMgmt::Action::"READ", resource);`;
const FORBID_POLICY = `forbid(principal, action, resource) when { resource.classification == "top_secret" };`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("cedar_diff_policy_stores", () => {
  let tmpDir: string;
  let manager: StoreManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cedar-diff-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    manager = new StoreManager();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports no changes when blue and green are identical", async () => {
    const policies = { admin: ADMIN_POLICY, editor: EDITOR_POLICY_V1 };
    const bluePath = makeStore(tmpDir, "blue", policies);
    const greenPath = makeStore(tmpDir, "green", policies);
    manager.loadFromRoots([
      { uri: `file://${bluePath}`, name: "blue" },
      { uri: `file://${greenPath}`, name: "green" },
    ]);

    const result = await handleDiffStores({ blue: "blue", green: "green" }, manager);
    expect(result.error).toBeUndefined();
    expect(result.policies_added).toHaveLength(0);
    expect(result.policies_removed).toHaveLength(0);
    expect(result.policies_modified).toHaveLength(0);
    expect(result.schema_diff.risk_level).toBe("safe");
    expect(result.schema_diff.entity_types.modified).toHaveLength(0);
    expect(result.summary).toMatch(/no changes/i);
  });

  it("detects a newly added policy in green", async () => {
    const bluePath = makeStore(tmpDir, "blue", { admin: ADMIN_POLICY });
    const greenPath = makeStore(tmpDir, "green", { admin: ADMIN_POLICY, viewer: VIEWER_POLICY });
    manager.loadFromRoots([
      { uri: `file://${bluePath}`, name: "blue" },
      { uri: `file://${greenPath}`, name: "green" },
    ]);

    const result = await handleDiffStores({ blue: "blue", green: "green" }, manager);
    expect(result.policies_added).toHaveLength(1);
    expect(result.policies_added[0]!.policy_id).toBe("viewer");
    expect(result.policies_removed).toHaveLength(0);
  });

  it("detects a removed policy (present in blue, absent in green)", async () => {
    const bluePath = makeStore(tmpDir, "blue", { admin: ADMIN_POLICY, viewer: VIEWER_POLICY });
    const greenPath = makeStore(tmpDir, "green", { admin: ADMIN_POLICY });
    manager.loadFromRoots([
      { uri: `file://${bluePath}`, name: "blue" },
      { uri: `file://${greenPath}`, name: "green" },
    ]);

    const result = await handleDiffStores({ blue: "blue", green: "green" }, manager);
    expect(result.policies_removed).toHaveLength(1);
    expect(result.policies_removed[0]!.policy_id).toBe("viewer");
    expect(result.policies_added).toHaveLength(0);
  });

  it("detects a condition change and classifies it as in-place OK", async () => {
    const bluePath = makeStore(tmpDir, "blue", { editor: EDITOR_POLICY_V1 });
    const greenPath = makeStore(tmpDir, "green", { editor: EDITOR_POLICY_V2_CONDITION_CHANGE });
    manager.loadFromRoots([
      { uri: `file://${bluePath}`, name: "blue" },
      { uri: `file://${greenPath}`, name: "green" },
    ]);

    const result = await handleDiffStores({ blue: "blue", green: "green" }, manager);
    expect(result.policies_modified).toHaveLength(1);
    const mod = result.policies_modified[0]!;
    expect(mod.policy_id).toBe("editor");
    expect(mod.can_update_in_place).toBe(true);
    expect(mod.changes.some((c) => c.field === "conditions")).toBe(true);
  });

  it("detects a principal change and classifies it as requires recreate", async () => {
    const bluePath = makeStore(tmpDir, "blue", { editor: EDITOR_POLICY_V1 });
    const greenPath = makeStore(tmpDir, "green", { editor: EDITOR_POLICY_V3_PRINCIPAL_CHANGE });
    manager.loadFromRoots([
      { uri: `file://${bluePath}`, name: "blue" },
      { uri: `file://${greenPath}`, name: "green" },
    ]);

    const result = await handleDiffStores({ blue: "blue", green: "green" }, manager);
    expect(result.policies_modified).toHaveLength(1);
    const mod = result.policies_modified[0]!;
    expect(mod.can_update_in_place).toBe(false);
    expect(mod.changes.some((c) => c.field === "principal" && !c.in_place_allowed)).toBe(true);
  });

  it("handles multiple simultaneous changes correctly", async () => {
    const bluePath = makeStore(tmpDir, "blue", {
      admin: ADMIN_POLICY,
      editor: EDITOR_POLICY_V1,
      viewer: VIEWER_POLICY,
    });
    const greenPath = makeStore(tmpDir, "green", {
      admin: ADMIN_POLICY,                              // unchanged
      editor: EDITOR_POLICY_V3_PRINCIPAL_CHANGE,        // principal change (recreate)
      forbid: FORBID_POLICY,                            // added
      // viewer removed
    });
    manager.loadFromRoots([
      { uri: `file://${bluePath}`, name: "blue" },
      { uri: `file://${greenPath}`, name: "green" },
    ]);

    const result = await handleDiffStores({ blue: "blue", green: "green" }, manager);
    expect(result.policies_added).toHaveLength(1);
    expect(result.policies_added[0]!.policy_id).toBe("forbid");
    expect(result.policies_removed).toHaveLength(1);
    expect(result.policies_removed[0]!.policy_id).toBe("viewer");
    expect(result.policies_modified).toHaveLength(1);
    expect(result.policies_modified[0]!.can_update_in_place).toBe(false);
  });

  it("detects schema changes", async () => {
    const altSchema = SCHEMA_TEXT.replace("name: String", "name: String, email: String");
    const bluePath = makeStore(tmpDir, "blue", { admin: ADMIN_POLICY }, SCHEMA_TEXT);
    const greenPath = makeStore(tmpDir, "green", { admin: ADMIN_POLICY }, altSchema);
    manager.loadFromRoots([
      { uri: `file://${bluePath}`, name: "blue" },
      { uri: `file://${greenPath}`, name: "green" },
    ]);

    const result = await handleDiffStores({ blue: "blue", green: "green" }, manager);

    // Structured schema_diff: User.email added as required attribute → breaking
    const userMod = result.schema_diff.entity_types.modified.find((m) => m.name === "User");
    expect(userMod).toBeDefined();
    const emailChange = userMod!.attribute_changes?.find((c) => c.attr === "email");
    expect(emailChange).toBeDefined();
    expect(emailChange!.change).toBe("added");
    expect(emailChange!.risk).toBe("breaking");
    expect(result.schema_diff.risk_level).toBe("breaking");
    expect(result.summary).toMatch(/schema changed.*BREAKING/);
  });

  it("schema_diff is populated with empty diff when schemas match", async () => {
    const bluePath = makeStore(tmpDir, "blue", { admin: ADMIN_POLICY }, SCHEMA_TEXT);
    const greenPath = makeStore(tmpDir, "green", { admin: ADMIN_POLICY }, SCHEMA_TEXT);
    manager.loadFromRoots([
      { uri: `file://${bluePath}`, name: "blue" },
      { uri: `file://${greenPath}`, name: "green" },
    ]);

    const result = await handleDiffStores({ blue: "blue", green: "green" }, manager);

    expect(result.schema_diff.entity_types.added).toHaveLength(0);
    expect(result.schema_diff.entity_types.removed).toHaveLength(0);
    expect(result.schema_diff.entity_types.modified).toHaveLength(0);
    expect(result.schema_diff.actions.added).toHaveLength(0);
    expect(result.schema_diff.actions.removed).toHaveLength(0);
    expect(result.schema_diff.risk_level).toBe("safe");
  });

  it("schema_diff surfaces action removal as breaking", async () => {
    // Strip the WRITE and DELETE action declarations — each is its own statement ending in `};`
    const altSchema = SCHEMA_TEXT
      .replace("action WRITE appliesTo { principal: [User], resource: [Document], context: {} };", "")
      .replace("action DELETE appliesTo { principal: [User], resource: [Document], context: {} };", "");
    const bluePath = makeStore(tmpDir, "blue", { admin: ADMIN_POLICY }, SCHEMA_TEXT);
    const greenPath = makeStore(tmpDir, "green", { admin: ADMIN_POLICY }, altSchema);
    manager.loadFromRoots([
      { uri: `file://${bluePath}`, name: "blue" },
      { uri: `file://${greenPath}`, name: "green" },
    ]);

    const result = await handleDiffStores({ blue: "blue", green: "green" }, manager);

    expect(result.schema_diff.actions.removed.length).toBeGreaterThanOrEqual(2);
    expect(result.schema_diff.risk_level).toBe("breaking");
  });

  it("behavioral diff — reports invalid requests instead of silently skipping", async () => {
    const bluePath = makeStore(tmpDir, "blue", { admin: ADMIN_POLICY });
    const greenPath = makeStore(tmpDir, "green", { admin: ADMIN_POLICY });
    manager.loadFromRoots([
      { uri: `file://${bluePath}`, name: "blue" },
      { uri: `file://${greenPath}`, name: "green" },
    ]);

    const result = await handleDiffStores({
      blue: "blue",
      green: "green",
      behavioral_test_requests: JSON.stringify([
        {
          principal: "bad-format-no-colons",  // invalid
          action: 'DocMgmt::Action::"READ"',
          resource: 'DocMgmt::Document::"d1"',
          entities: "[]",
        },
      ]),
    }, manager);

    // Invalid requests should appear in behavioral_diff with drifted:false and an error note
    // NOT silently disappear from the results
    expect(result.behavioral_diff).toBeDefined();
    expect(result.behavioral_diff!.length).toBe(1);
    expect(result.behavioral_diff![0]!.drifted).toBe(false);
    expect(result.behavioral_diff![0]!.blue_decision).toBe("Error");
  });

  it("returns error for unknown store name", async () => {
    const bluePath = makeStore(tmpDir, "blue", { admin: ADMIN_POLICY });
    manager.loadFromRoots([{ uri: `file://${bluePath}`, name: "blue" }]);

    const result = await handleDiffStores({ blue: "blue", green: "ghost" }, manager);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/ghost/);
  });

  it("behavioral diff — detects decision drift between blue and green", async () => {
    // Blue: editor can write; Green: editor can only read (principal change)
    const bluePath = makeStore(tmpDir, "blue", { editor: EDITOR_POLICY_V1 });
    const greenPath = makeStore(tmpDir, "green", { editor: VIEWER_POLICY }); // viewer policy = READ only
    manager.loadFromRoots([
      { uri: `file://${bluePath}`, name: "blue" },
      { uri: `file://${greenPath}`, name: "green" },
    ]);

    const behavioralTests = JSON.stringify([
      {
        principal: 'DocMgmt::User::"bob"',
        action: 'DocMgmt::Action::"WRITE"',
        resource: 'DocMgmt::Document::"doc-1"',
        entities: JSON.stringify([
          { uid: { type: "DocMgmt::User", id: "bob" }, attrs: { name: "Bob" }, parents: [{ type: "DocMgmt::Role", id: "editor" }] },
          { uid: { type: "DocMgmt::Role", id: "editor" }, attrs: {}, parents: [] },
          { uid: { type: "DocMgmt::Document", id: "doc-1" }, attrs: { classification: "public" }, parents: [] },
        ]),
      },
    ]);

    const result = await handleDiffStores(
      { blue: "blue", green: "green", behavioral_test_requests: behavioralTests },
      manager
    );

    expect(result.behavioral_diff).toBeDefined();
    expect(result.behavioral_diff!.length).toBeGreaterThan(0);
    const drift = result.behavioral_diff![0]!;
    expect(drift.blue_decision).toBe("Allow");
    expect(drift.green_decision).toBe("Deny");
    expect(drift.drifted).toBe(true);
  });
});
