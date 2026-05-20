import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAdvise, type Sampler } from "../../src/tools/advise.js";
import { StoreManager } from "../../src/resources/store-manager.js";

// ─── Fixture data ─────────────────────────────────────────────────────────────

const SCHEMA_CEDARSCHEMA = `namespace DocMgmt {
  entity User in [Role] = { name: String };
  entity Role;
  entity Document = { classification: String, business_unit: String };
  action READ appliesTo { principal: [User], resource: [Document], context: {} };
  action WRITE appliesTo { principal: [User], resource: [Document], context: {} };
}`;

const ADMIN_POLICY = `permit(principal in DocMgmt::Role::"admin", action, resource);`;
const EDITOR_POLICY = `permit(principal in DocMgmt::Role::"editor", action == DocMgmt::Action::"READ", resource);`;

function makeStore(baseDir: string, name: string, policies: Record<string, string>): string {
  const path = join(baseDir, name);
  mkdirSync(join(path, "policies"), { recursive: true });
  for (const [id, content] of Object.entries(policies)) {
    writeFileSync(join(path, "policies", `${id}.cedar`), content);
  }
  writeFileSync(join(path, "schema.cedarschema"), SCHEMA_CEDARSCHEMA);
  return path;
}

// ─── Mock responses ───────────────────────────────────────────────────────────

const PLAN_ABAC_ON_RBAC = {
  intent_interpretation: "Add a business unit matching constraint to the existing read permission",
  applicable_cedar_pattern: "Membership (RBAC) layered with ABAC condition",
  affected_entities: {
    principal_type: "DocMgmt::User",
    action_ids: ["READ"],
    resource_type: "DocMgmt::Document",
  },
  required_changes: [
    {
      step: 1,
      type: "schema",
      description: "Add optional home_business_unit attribute to User entity",
      rationale: "Cedar policies can only reference schema-declared attributes.",
      cedar_snippet: `entity User in [Role] { name: String, home_business_unit?: String };`,
    },
    {
      step: 2,
      type: "policy_modify",
      policy_id: "editor",
      description: "Add business unit matching condition to read permission",
      rationale: "The when clause is mutable via AVP UpdatePolicy. No delete+recreate needed.",
      cedar_snippet_before: EDITOR_POLICY,
      cedar_snippet_after: `permit(principal in DocMgmt::Role::"editor", action == DocMgmt::Action::"READ", resource)\nwhen { principal has home_business_unit && principal.home_business_unit == resource.business_unit };`,
      avp_update_mode: "in_place_via_update_policy",
    },
  ],
  gotchas: [
    {
      id: "optional_attribute_guard",
      severity: "high",
      description: "home_business_unit is optional — must guard with `principal has home_business_unit` before access.",
      avp_error_category: "UnsafeOptionalAttributeAccess",
    },
  ],
  verification_next_steps: "Run cedar_diff_policy_stores against production to verify behavioral drift.",
};

const PLAN_FORBID_SENSITIVE = {
  intent_interpretation: "Block everyone from accessing top-secret documents except admins",
  applicable_cedar_pattern: "Discretionary forbid with Membership exemption",
  affected_entities: {
    principal_type: "DocMgmt::User",
    action_ids: ["READ", "WRITE"],
    resource_type: "DocMgmt::Document",
  },
  required_changes: [
    {
      step: 1,
      type: "policy_new",
      description: "Create forbid policy for top-secret documents with admin exemption",
      rationale: "New policy — use AVP CreatePolicy.",
      cedar_snippet: `forbid(principal, action, resource) when { resource.classification == "top_secret" } unless { principal in DocMgmt::Role::"admin" };`,
      avp_update_mode: "new_policy_via_create_policy",
    },
  ],
  gotchas: [
    {
      id: "forbid_overrides_permit",
      severity: "high",
      description: "A single forbid overrides all permit policies. The unless clause provides the admin escape hatch.",
    },
  ],
  verification_next_steps: "Test with a non-admin user attempting to read a top_secret document.",
};

const DELTA_WEEKEND_BLOCK = {
  delta_from_previous: true,
  unchanged_steps: [1],
  modified_steps: [
    {
      step: 2,
      before: { step: 2, type: "policy_modify", description: "Add time window 09:00-17:00" },
      after: { step: 2, type: "policy_modify", description: "Add time window 09:00-17:00 weekdays only" },
      reason: "Extended condition to also block weekends",
    },
  ],
  added_steps: [],
  removed_steps: [],
  intent_interpretation: "Restrict admin access to 09:00-17:00 weekdays only",
  applicable_cedar_pattern: "Membership (RBAC) with temporal context guard",
  affected_entities: { principal_type: "DocMgmt::User", action_ids: ["READ", "WRITE"], resource_type: "DocMgmt::Document" },
  required_changes: [
    { step: 1, type: "schema", description: "Add time-related context" },
    {
      step: 2,
      type: "policy_modify",
      description: "Add time window + weekend block condition",
      avp_update_mode: "in_place_via_update_policy",
    },
  ],
  gotchas: [],
  verification_next_steps: "Test with context at different hours and days.",
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function mockSampler(response: unknown): Sampler {
  return async () => JSON.stringify(response);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("cedar_advise", () => {
  let tmpDir: string;
  let manager: StoreManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cedar-advise-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    manager = new StoreManager();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Prompt structure ───────────────────────────────────────────────────────

  it("A1 — prompt contains Cedar patterns and AVP rules reference", async () => {
    let capturedUser = "";
    let capturedSystem = "";
    const sampler: Sampler = async (up, sp) => {
      capturedUser = up;
      capturedSystem = sp;
      return JSON.stringify(PLAN_ABAC_ON_RBAC);
    };

    await handleAdvise({ intent: "Restrict read to business unit match" }, sampler);

    expect(capturedSystem).toContain("Cedar");
    expect(capturedSystem).toContain("JSON");
    expect(capturedUser).toContain("Cedar Policy Patterns");
    expect(capturedUser).toContain("AVP UpdatePolicy");
    expect(capturedUser).toContain("Restrict read to business unit match");
  });

  it("A2 — prompt selects optional_attribute_guard gotcha for email/verified intent", async () => {
    let capturedUser = "";
    const sampler: Sampler = async (up) => { capturedUser = up; return JSON.stringify(PLAN_ABAC_ON_RBAC); };

    await handleAdvise({ intent: "Require verified email attribute before granting access" }, sampler);

    expect(capturedUser).toContain("optional_attribute_guard");
  });

  it("A3 — prompt selects forbid_overrides_permit gotcha for block/deny intent", async () => {
    let capturedUser = "";
    const sampler: Sampler = async (up) => { capturedUser = up; return JSON.stringify(PLAN_FORBID_SENSITIVE); };

    await handleAdvise({ intent: "Block everyone from accessing sensitive documents" }, sampler);

    expect(capturedUser).toContain("forbid_overrides_permit");
  });

  // ─── Response parsing ────────────────────────────────────────────────────────

  it("A4 — parses structured JSON response correctly", async () => {
    const result = await handleAdvise({ intent: "Add ABAC constraint" }, mockSampler(PLAN_ABAC_ON_RBAC));

    expect(result.error).toBeUndefined();
    expect(result.intent_interpretation).toBeDefined();
    expect(result.applicable_cedar_pattern).toContain("RBAC");
    expect(result.required_changes).toHaveLength(2);
    expect(result.required_changes![0]!.step).toBe(1);
    expect(result.required_changes![0]!.type).toBe("schema");
    expect(result.required_changes![1]!.avp_update_mode).toBe("in_place_via_update_policy");
    expect(result.gotchas).toHaveLength(1);
    expect(result.gotchas![0]!.severity).toBe("high");
  });

  it("A5 — parses markdown-wrapped JSON response", async () => {
    const sampler: Sampler = async () => `\`\`\`json\n${JSON.stringify(PLAN_ABAC_ON_RBAC)}\n\`\`\``;
    const result = await handleAdvise({ intent: "test" }, sampler);

    expect(result.error).toBeUndefined();
    expect(result.intent_interpretation).toBeDefined();
    expect(result.required_changes).toHaveLength(2);
  });

  it("A6 — returns error with raw_response when sampler returns invalid JSON", async () => {
    const sampler: Sampler = async () => "I cannot produce a structured plan for this intent.";
    const result = await handleAdvise({ intent: "test" }, sampler);

    expect(result.error).toMatch(/parse/i);
    expect(result.raw_response).toBeDefined();
    expect(result.raw_response).toContain("I cannot produce");
  });

  // ─── Store context ───────────────────────────────────────────────────────────

  it("A7 — includes store context in prompt when store_ref provided", async () => {
    const storePath = makeStore(tmpDir, "mystore", { admin: ADMIN_POLICY, editor: EDITOR_POLICY });
    manager.loadFromRoots([{ uri: `file://${storePath}`, name: "mystore" }]);

    let capturedUser = "";
    const sampler: Sampler = async (up) => { capturedUser = up; return JSON.stringify(PLAN_ABAC_ON_RBAC); };

    await handleAdvise({ intent: "Add business unit constraint", store_ref: "mystore" }, sampler, manager);

    expect(capturedUser).toContain("mystore");
    expect(capturedUser).toContain("admin");
    expect(capturedUser).toContain("editor");
    expect(capturedUser).toContain("Schema:");
  });

  it("A8 — resolves cedar:// store_ref prefix", async () => {
    const storePath = makeStore(tmpDir, "production", { admin: ADMIN_POLICY });
    manager.loadFromRoots([{ uri: `file://${storePath}`, name: "production" }]);

    let capturedUser = "";
    const sampler: Sampler = async (up) => { capturedUser = up; return JSON.stringify(PLAN_ABAC_ON_RBAC); };

    await handleAdvise(
      { intent: "Update policy", store_ref: "cedar://policies/production" },
      sampler,
      manager
    );

    expect(capturedUser).toContain("production");
  });

  it("A9 — gracefully handles unknown store_ref", async () => {
    let capturedUser = "";
    const sampler: Sampler = async (up) => { capturedUser = up; return JSON.stringify(PLAN_ABAC_ON_RBAC); };

    await handleAdvise({ intent: "test", store_ref: "nonexistent" }, sampler, manager);

    expect(capturedUser).toContain("nonexistent");
    expect(capturedUser).toContain("not found");
  });

  // ─── Delta / previous_plan ────────────────────────────────────────────────────

  it("A10 — includes previous_plan in prompt and uses delta schema", async () => {
    let capturedUser = "";
    const sampler: Sampler = async (up) => { capturedUser = up; return JSON.stringify(DELTA_WEEKEND_BLOCK); };

    const result = await handleAdvise({
      intent: "Also block weekends",
      previous_plan: PLAN_ABAC_ON_RBAC,
    }, sampler);

    expect(capturedUser).toContain("Previous Plan");
    expect(capturedUser).toContain("delta");
    expect(result.delta_from_previous).toBe(true);
    expect(result.unchanged_steps).toContain(1);
    expect(result.modified_steps).toHaveLength(1);
  });

  it("A11 — no previous_plan uses full plan schema (no delta fields in prompt)", async () => {
    let capturedUser = "";
    const sampler: Sampler = async (up) => { capturedUser = up; return JSON.stringify(PLAN_ABAC_ON_RBAC); };

    await handleAdvise({ intent: "Fresh request" }, sampler);

    expect(capturedUser).not.toContain("Previous Plan");
    // Full output schema — not delta
    expect(capturedUser).toContain("intent_interpretation");
    expect(capturedUser).toContain("required_changes");
  });

  // ─── Forbid + unless pattern (Example 2) ────────────────────────────────────

  it("A12 — forbid+unless plan: new policy classified as new_policy_via_create_policy", async () => {
    const result = await handleAdvise(
      { intent: "Block sensitive documents for non-admins" },
      mockSampler(PLAN_FORBID_SENSITIVE)
    );

    expect(result.error).toBeUndefined();
    expect(result.required_changes![0]!.avp_update_mode).toBe("new_policy_via_create_policy");
    expect(result.gotchas!.some(g => g.id === "forbid_overrides_permit")).toBe(true);
  });

  // ─── Audit-gap fixes ──────────────────────────────────────────────────────────

  it("A13 — store context includes actual policy text so LLM can produce cedar_snippet_before", async () => {
    const storePath = makeStore(tmpDir, "withtext", { admin: ADMIN_POLICY, editor: EDITOR_POLICY });
    manager.loadFromRoots([{ uri: `file://${storePath}`, name: "withtext" }]);

    let capturedUser = "";
    const sampler: Sampler = async (up) => { capturedUser = up; return JSON.stringify(PLAN_ABAC_ON_RBAC); };

    await handleAdvise({ intent: "Add constraint", store_ref: "withtext" }, sampler, manager);

    // The actual Cedar policy text must appear in the prompt so the LLM can reference it
    expect(capturedUser).toContain('Role::"admin"');
    expect(capturedUser).toContain('Role::"editor"');
  });

  it("A14 — LLM policy_new with wrong avp_update_mode is corrected to new_policy_via_create_policy", async () => {
    const badPlan = {
      ...PLAN_FORBID_SENSITIVE,
      required_changes: [
        {
          ...PLAN_FORBID_SENSITIVE.required_changes[0],
          type: "policy_new",
          avp_update_mode: "in_place_via_update_policy",  // wrong
        },
      ],
    };
    const result = await handleAdvise({ intent: "block access" }, mockSampler(badPlan));

    expect(result.required_changes![0]!.avp_update_mode).toBe("new_policy_via_create_policy");
  });

  it("A15 — LLM policy_delete with wrong avp_update_mode is corrected to requires_delete_recreate", async () => {
    const badPlan = {
      ...PLAN_ABAC_ON_RBAC,
      required_changes: [
        {
          step: 1,
          type: "policy_delete",
          description: "Remove old editor policy",
          avp_update_mode: "in_place_via_update_policy",  // wrong
        },
      ],
    };
    const result = await handleAdvise({ intent: "migrate to rebac" }, mockSampler(badPlan));

    expect(result.required_changes![0]!.avp_update_mode).toBe("requires_delete_recreate");
  });

  it("A16 — schema step ordering: adds warning when policy step precedes schema step", async () => {
    const misordered = {
      ...PLAN_ABAC_ON_RBAC,
      required_changes: [
        { step: 1, type: "policy_modify", description: "Modify policy first", avp_update_mode: "in_place_via_update_policy" },
        { step: 2, type: "schema", description: "Add attribute second (wrong order)" },
      ],
    };
    const result = await handleAdvise({ intent: "add attribute" }, mockSampler(misordered));

    // Should have a gotcha warning about ordering
    expect(result.gotchas!.some(g => g.id === "schema_first_then_policy")).toBe(true);
  });
});
