import { describe, it, expect } from "vitest";
import { handleValidate } from "../../src/tools/validate.js";
import { POLICIES, SCHEMA_JSON } from "../fixtures/docmgmt.js";

const SCHEMA_STR = JSON.stringify(SCHEMA_JSON);

describe("cedar_validate", () => {
  it("returns valid for correct policies against schema", async () => {
    const result = await handleValidate({ policies: POLICIES, schema: SCHEMA_STR });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns invalid for a policy referencing a non-existent attribute", async () => {
    const bad = `permit(principal, action, resource) when { resource.nonexistent == "x" };`;
    const result = await handleValidate({ policies: bad, schema: SCHEMA_STR });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain("nonexistent");
  });

  it("includes policy_count in result", async () => {
    const result = await handleValidate({ policies: POLICIES, schema: SCHEMA_STR });

    expect(result.policy_count).toBe(4);
  });

  it("accepts Cedar text schema format", async () => {
    const cedarSchema = `
      namespace DocMgmt {
        entity User in [Role] = { name: String, email: String };
        entity Role;
        entity Document in [Folder] = { owner: String, classification: String };
        entity Folder;
        action READ appliesTo { principal: [User], resource: [Document], context: {} };
        action WRITE appliesTo { principal: [User], resource: [Document], context: {} };
        action DELETE appliesTo { principal: [User], resource: [Document], context: {} };
      }
    `.trim();

    const result = await handleValidate({ policies: POLICIES, schema: cedarSchema });
    expect(result.valid).toBe(true);
  });
});
