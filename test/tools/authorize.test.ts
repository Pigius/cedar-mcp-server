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
