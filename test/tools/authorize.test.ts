import { describe, it, expect } from "vitest";
import { handleAuthorize } from "../../src/tools/authorize.js";
import { POLICIES, SCHEMA_JSON, ENTITIES } from "../fixtures/docmgmt.js";

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
