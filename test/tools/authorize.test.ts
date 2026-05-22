import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAuthorize, handleAuthorizeMcp } from "../../src/tools/authorize.js";
import { storeManager } from "../../src/resources/store-manager.js";
import { POLICIES, SCHEMA_JSON, ENTITIES } from "../fixtures/docmgmt.js";

// resolveRef stub: the 10d auto-discovery tests never use `_ref` fields, so
// any call into this stub indicates a test bug (the auto-discovery flow took
// an unexpected branch). Surface that loudly rather than returning blank.
const noResolve = (uri: string): { content: string } | { error: string } => ({
  error: `unexpected resolveRef call in auto-discovery test: ${uri}`,
});

describe("cedar_authorize", () => {
  it("allows alice (admin) to read doc-public", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });

    expect(result.decision).toBe("Allow");
    expect(result.errors).toHaveLength(0);
  });

  it("denies dave (no role) reading doc-public — default deny", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"dave"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });

    expect(result.decision).toBe("Deny");
    expect(result.determining_policies).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("denies bob (editor) reading doc-secret — forbid overrides permit", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"bob"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-secret"',
      entities: JSON.stringify(ENTITIES),
    });

    expect(result.decision).toBe("Deny");
    expect(result.errors).toHaveLength(0);
  });

  it("allows alice (admin) to read doc-secret — admin exempt from forbid", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-secret"',
      entities: JSON.stringify(ENTITIES),
    });

    expect(result.decision).toBe("Allow");
    expect(result.errors).toHaveLength(0);
  });

  it("surfaces determining_policies on allow", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"charlie"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });

    expect(result.decision).toBe("Allow");
    expect(result.determining_policies.length).toBeGreaterThan(0);
  });

  it("unwraps AVP entity_list envelope (Ruby SDK full entities parameter)", async () => {
    // Ruby SDK sends: entities: { entity_list: [...] }
    // Users who copy the full SDK entities value get this structure
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify({ entity_list: ENTITIES }),
    });
    expect(result.decision).toBe("Allow");
    expect(result.error).toBeUndefined();
  });

  it("unwraps AVP entityList envelope (Python/JS SDK full entities parameter)", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify({ entityList: ENTITIES }),
    });
    expect(result.decision).toBe("Allow");
    expect(result.error).toBeUndefined();
  });

  it("returns structured error for malformed entity reference instead of throwing", async () => {
    const result = await handleAuthorize({
      policies: `permit(principal, action, resource);`,
      principal: "bad-format-no-quotes",
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });

    expect(result.error).toBeDefined();
    expect(result.decision).toBe("Deny");
  });

  it("returns structured error for invalid entities JSON instead of throwing", async () => {
    const result = await handleAuthorize({
      policies: `permit(principal, action, resource);`,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: "not valid json",
    });

    expect(result.error).toBeDefined();
    expect(result.error).toContain("entities");
    expect(result.decision).toBe("Deny");
  });

  it("accepts schema and validates the request", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
      schema: JSON.stringify(SCHEMA_JSON),
    });

    expect(result.decision).toBe("Allow");
    expect(result.errors).toHaveLength(0);
  });
});

describe("cedar_authorize — format detection and auto-normalization", () => {
  // AVP format entities: identifier key + typed attribute wrappers + entity_type/entity_id parents
  const AVP_ENTITIES = JSON.stringify([
    {
      identifier: { entity_type: "DocMgmt::User", entity_id: "alice" },
      attributes: {
        name: { string: "Alice Smith" },
        email: { string: "alice@example.com" },
      },
      parents: [{ entity_type: "DocMgmt::Role", entity_id: "admin" }],
    },
    {
      identifier: { entity_type: "DocMgmt::User", entity_id: "bob" },
      attributes: {
        name: { string: "Bob Jones" },
        email: { string: "bob@example.com" },
      },
      parents: [{ entity_type: "DocMgmt::Role", entity_id: "editor" }],
    },
    {
      identifier: { entity_type: "DocMgmt::Role", entity_id: "admin" },
      attributes: {},
      parents: [],
    },
    {
      identifier: { entity_type: "DocMgmt::Role", entity_id: "editor" },
      attributes: {},
      parents: [],
    },
    {
      identifier: { entity_type: "DocMgmt::Document", entity_id: "doc-public" },
      attributes: {
        owner: { string: "alice" },
        classification: { string: "public" },
      },
      parents: [],
    },
    {
      identifier: { entity_type: "DocMgmt::Document", entity_id: "doc-secret" },
      attributes: {
        owner: { string: "alice" },
        classification: { string: "top_secret" },
      },
      parents: [],
    },
  ]);

  // AVP-style principal/action/resource objects
  const avpPrincipal = { entity_type: "DocMgmt::User", entity_id: "alice" };
  const avpAction = { action_type: "DocMgmt::Action", action_id: "READ" };
  const avpResource = { entity_type: "DocMgmt::Document", entity_id: "doc-public" };

  it("allows alice (admin) using AVP entity format — auto-normalized", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: avpPrincipal as unknown as string,
      action: avpAction as unknown as string,
      resource: avpResource as unknown as string,
      entities: AVP_ENTITIES,
    });

    expect(result.decision).toBe("Allow");
    expect(result.format_detected).toBe("avp");
    expect(result.format_note).toContain("AVP format");
    expect(result.errors).toHaveLength(0);
  });

  it("denies bob (editor) reading top-secret doc — AVP format, forbid still fires", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: { entity_type: "DocMgmt::User", entity_id: "bob" } as unknown as string,
      action: { action_type: "DocMgmt::Action", action_id: "READ" } as unknown as string,
      resource: { entity_type: "DocMgmt::Document", entity_id: "doc-secret" } as unknown as string,
      entities: AVP_ENTITIES,
    });

    expect(result.decision).toBe("Deny");
    expect(result.format_detected).toBe("avp");
  });

  it("reports cedar format when Cedar string literals are passed", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });

    expect(result.decision).toBe("Allow");
    expect(result.format_detected).toBe("cedar");
  });

  it("camelCase AVP format (Python/JS SDK) — auto-normalized and evaluated correctly", async () => {
    const result = await handleAuthorize({
      policies: `permit(principal in DocMgmt::Role::"admin", action, resource);`,
      principal: { entityType: "DocMgmt::User", entityId: "alice" } as unknown as string,
      action: { actionType: "DocMgmt::Action", actionId: "READ" } as unknown as string,
      resource: { entityType: "DocMgmt::Document", entityId: "doc-1" } as unknown as string,
      entities: JSON.stringify([
        {
          identifier: { entityType: "DocMgmt::User", entityId: "alice" },
          attributes: {},
          parents: [{ entityType: "DocMgmt::Role", entityId: "admin" }],
        },
        {
          identifier: { entityType: "DocMgmt::Role", entityId: "admin" },
          attributes: {},
          parents: [],
        },
        {
          identifier: { entityType: "DocMgmt::Document", entityId: "doc-1" },
          attributes: {},
          parents: [],
        },
      ]),
    });

    expect(result.decision).toBe("Allow");
    expect(result.format_detected).toBe("avp");
  });

  it("PascalCase AVP format (official API / AWS console) — auto-normalized and evaluated correctly", async () => {
    const result = await handleAuthorize({
      policies: `permit(principal in DocMgmt::Role::"admin", action, resource);`,
      principal: { EntityType: "DocMgmt::User", EntityId: "alice" } as unknown as string,
      action: { ActionType: "DocMgmt::Action", ActionId: "READ" } as unknown as string,
      resource: { EntityType: "DocMgmt::Document", EntityId: "doc-1" } as unknown as string,
      entities: JSON.stringify([
        {
          Identifier: { EntityType: "DocMgmt::User", EntityId: "alice" },
          Attributes: {},
          Parents: [{ EntityType: "DocMgmt::Role", EntityId: "admin" }],
        },
        {
          Identifier: { EntityType: "DocMgmt::Role", EntityId: "admin" },
          Attributes: {},
          Parents: [],
        },
        {
          Identifier: { EntityType: "DocMgmt::Document", EntityId: "doc-1" },
          Attributes: {},
          Parents: [],
        },
      ]),
    });

    expect(result.decision).toBe("Allow");
    expect(result.format_detected).toBe("avp");
  });

  it("AVP typed attributes with non-string policy condition work correctly after unwrap", async () => {
    // Policy checks principal.name — must be unwrapped from { string: "alice" } to "alice"
    const policy = `permit(principal, action, resource) when { principal.name == "alice" };`;
    const result = await handleAuthorize({
      policies: policy,
      principal: { entity_type: "MyApp::User", entity_id: "user-1" } as unknown as string,
      action: { action_type: "MyApp::Action", action_id: "READ" } as unknown as string,
      resource: { entity_type: "MyApp::Resource", entity_id: "res-1" } as unknown as string,
      entities: JSON.stringify([
        {
          identifier: { entity_type: "MyApp::User", entity_id: "user-1" },
          attributes: { name: { string: "alice" } },
          parents: [],
        },
        {
          identifier: { entity_type: "MyApp::Resource", entity_id: "res-1" },
          attributes: {},
          parents: [],
        },
      ]),
    });

    // Without unwrapping: name would be { string: "alice" } (a Record), not "alice" — policy would not match
    expect(result.decision).toBe("Allow");
    expect(result.format_detected).toBe("avp");
  });
});

describe("cedar_authorize — H1 stable policy identifiers in determining_policies", () => {
  it("returns the @id annotation when a permit policy has one", async () => {
    const policies = `
@id("admin-read")
permit (
  principal,
  action == DocMgmt::Action::"READ",
  resource
);
`.trim();
    const result = await handleAuthorize({
      policies,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Allow");
    expect(result.determining_policies).toEqual(["admin-read"]);
  });

  it("falls back to policy<index> when no @id annotation and no file basename is known", async () => {
    const policies = `permit (principal, action, resource);`;
    const result = await handleAuthorize({
      policies,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Allow");
    expect(result.determining_policies).toEqual(["policy0"]);
  });

  it("uses the policiesMap key (file basename) as the determining policy id", async () => {
    const result = await handleAuthorize({
      policiesMap: {
        admin: `permit (principal in DocMgmt::Role::"admin", action, resource);`,
      },
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Allow");
    expect(result.determining_policies).toEqual(["admin"]);
  });

  it("prefers @id annotation over the policiesMap key when both are present", async () => {
    const result = await handleAuthorize({
      policiesMap: {
        admin: `@id("admin-read-all")\npermit (principal in DocMgmt::Role::"admin", action, resource);`,
      },
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Allow");
    expect(result.determining_policies).toEqual(["admin-read-all"]);
  });
});

describe("cedar_authorize — M3 decision_reason field", () => {
  it("returns decision_reason = permit_policy_fired on Allow", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Allow");
    expect(result.decision_reason).toBe("permit_policy_fired");
  });

  it("returns decision_reason = default_deny_no_permit_matched when no policy fires", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"dave"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Deny");
    expect(result.determining_policies).toHaveLength(0);
    expect(result.decision_reason).toBe("default_deny_no_permit_matched");
  });

  it("returns decision_reason = forbid_policy_fired when a forbid policy is determining", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"bob"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-secret"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Deny");
    expect(result.decision_reason).toBe("forbid_policy_fired");
  });

  it("returns decision_reason = evaluation_error when a policy errors during evaluation", async () => {
    // Policy reads principal.missing — entity lacks that attribute, causing an evaluation error.
    const policies = `permit(principal, action, resource) when { principal.missing == "x" };`;
    const result = await handleAuthorize({
      policies,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.decision_reason).toBe("evaluation_error");
  });
});

describe("cedar_authorize — 10c empirical response shape snapshots (H1 + M3 contract)", () => {
  // Round 3 (2026-05-22) doubted whether determining_policies returned stable
  // basenames (H1) and whether decision_reason was actually populated (M3).
  // These snapshot tests lock in the literal response shape for the canonical
  // cases so a future dogfood reviewer can read the test and see the contract,
  // rather than reasoning about it from the Cedar SDK alone.

  const ADMIN_POLICY = `permit (principal in DocMgmt::Role::"admin", action, resource);`;
  const FORBID_TOPSECRET = `forbid (principal, action, resource) when { resource.classification == "top_secret" } unless { principal in DocMgmt::Role::"admin" };`;

  it("Allow via admin role: determining_policies uses the policiesMap basename, decision_reason = permit_policy_fired", async () => {
    const result = await handleAuthorize({
      policiesMap: { admin: ADMIN_POLICY },
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "decision": "Allow",
        "decision_reason": "permit_policy_fired",
        "determining_policies": [
          "admin",
        ],
        "errors": [],
        "format_detected": "cedar",
        "format_note": "Input is in Cedar/WASM format.",
      }
    `);
  });

  it("Default deny (no policy fires): determining_policies is empty, decision_reason = default_deny_no_permit_matched", async () => {
    const result = await handleAuthorize({
      policiesMap: { admin: ADMIN_POLICY },
      principal: 'DocMgmt::User::"dave"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "decision": "Deny",
        "decision_reason": "default_deny_no_permit_matched",
        "determining_policies": [],
        "errors": [],
        "format_detected": "cedar",
        "format_note": "Input is in Cedar/WASM format.",
      }
    `);
  });

  it("Forbid fires for non-admin on top_secret: determining_policies surfaces forbid id, decision_reason = forbid_policy_fired", async () => {
    const result = await handleAuthorize({
      policiesMap: {
        admin: ADMIN_POLICY,
        "forbid-topsecret": FORBID_TOPSECRET,
      },
      principal: 'DocMgmt::User::"bob"',
      action: 'DocMgmt::Action::"READ"',
      resource: 'DocMgmt::Document::"doc-secret"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "decision": "Deny",
        "decision_reason": "forbid_policy_fired",
        "determining_policies": [
          "forbid-topsecret",
        ],
        "errors": [],
        "format_detected": "cedar",
        "format_note": "Input is in Cedar/WASM format.",
      }
    `);
  });
});

describe("cedar_authorize — 10d auto-discovery", () => {
  const tempDirs: string[] = [];

  // Minimal Cedar workspace fixture: schema + one permit-admin policy + entities
  // covering alice (admin) and doc-public. Exercises all three auto-discovery
  // axes (policies / schema / entities) so a successful Allow demonstrates the
  // wrapper resolved every missing input from the workspace.
  const SCHEMA_TEXT = `namespace DocMgmt {
  entity User in [Role] = { name: String, email: String };
  entity Role;
  entity Document in [Folder] = { owner: String, classification: String };
  entity Folder;
  action READ appliesTo { principal: [User], resource: [Document], context: {} };
  action WRITE appliesTo { principal: [User], resource: [Document], context: {} };
  action DELETE appliesTo { principal: [User], resource: [Document], context: {} };
}`;

  function makeWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "cedar-authorize-auto-"));
    mkdirSync(join(dir, "policies"), { recursive: true });
    mkdirSync(join(dir, "entities"), { recursive: true });
    writeFileSync(
      join(dir, "policies", "admin.cedar"),
      `permit (principal in DocMgmt::Role::"admin", action, resource);`,
    );
    writeFileSync(join(dir, "schema.cedarschema"), SCHEMA_TEXT);
    writeFileSync(join(dir, "entities", "world.json"), JSON.stringify(ENTITIES));
    return dir;
  }

  afterEach(() => {
    // Reset the singleton so per-test state never leaks into other suites.
    storeManager.loadFromRoots([]);
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("single store loaded auto-pulls policies, schema, and entities (alice admin Allow)", async () => {
    const ws = makeWorkspace();
    tempDirs.push(ws);
    storeManager.loadFromRoots([{ uri: `file://${ws}`, name: "workspace" }]);

    const outcome = await handleAuthorizeMcp(
      {
        principal: 'DocMgmt::User::"alice"',
        action: 'DocMgmt::Action::"READ"',
        resource: 'DocMgmt::Document::"doc-public"',
      },
      noResolve,
    );

    expect("error" in outcome).toBe(false);
    if ("error" in outcome) return;
    expect(outcome.result.decision).toBe("Allow");
    expect(outcome.result.errors).toEqual([]);
    expect(outcome.result.determining_policies).toEqual(["admin"]);
    expect(outcome.result.auto_discovered).toEqual({
      policies_from: "workspace",
      schema_from: "workspace",
      entities_from: "workspace",
    });
  });

  it("honors an explicit store parameter when multiple stores are loaded", async () => {
    const blue = makeWorkspace();
    const green = makeWorkspace();
    tempDirs.push(blue, green);
    storeManager.loadFromRoots([
      { uri: `file://${blue}`, name: "blue" },
      { uri: `file://${green}`, name: "green" },
    ]);

    const outcome = await handleAuthorizeMcp(
      {
        principal: 'DocMgmt::User::"alice"',
        action: 'DocMgmt::Action::"READ"',
        resource: 'DocMgmt::Document::"doc-public"',
        store: "green",
      },
      noResolve,
    );

    expect("error" in outcome).toBe(false);
    if ("error" in outcome) return;
    expect(outcome.result.decision).toBe("Allow");
    expect(outcome.result.auto_discovered).toEqual({
      policies_from: "green",
      schema_from: "green",
      entities_from: "green",
    });
  });

  it("returns an ambiguity error when multiple stores are loaded and no store is passed", async () => {
    const blue = makeWorkspace();
    const green = makeWorkspace();
    tempDirs.push(blue, green);
    storeManager.loadFromRoots([
      { uri: `file://${blue}`, name: "blue" },
      { uri: `file://${green}`, name: "green" },
    ]);

    const outcome = await handleAuthorizeMcp(
      {
        principal: 'DocMgmt::User::"alice"',
        action: 'DocMgmt::Action::"READ"',
        resource: 'DocMgmt::Document::"doc-public"',
      },
      noResolve,
    );

    expect("error" in outcome).toBe(true);
    if (!("error" in outcome)) return;
    expect(outcome.error).toMatch(/Multiple stores are loaded/);
    expect(outcome.error).toContain("blue");
    expect(outcome.error).toContain("green");
    expect(outcome.error).toMatch(/Pass store/);
  });
});
