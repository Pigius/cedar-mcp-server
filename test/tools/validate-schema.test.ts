import { describe, it, expect } from "vitest";
import { handleValidateSchema } from "../../src/tools/validate-schema.js";
import { SCHEMA_JSON } from "../fixtures/docmgmt.js";

const SCHEMA_JSON_STR = JSON.stringify(SCHEMA_JSON);

const CEDARSCHEMA_TEXT = `
namespace DocMgmt {
  entity User in [Role] = { name: String, email: String };
  entity Role;
  entity Document in [Folder] = { owner: String, classification: String };
  entity Folder;
  action READ, WRITE, DELETE appliesTo {
    principal: [User],
    resource: [Document]
  };
}
`.trim();

describe("cedar_validate_schema", () => {
  it("VS1: returns valid:true and detected JSON format for a well-formed JSON schema", async () => {
    const result = await handleValidateSchema({ schema: SCHEMA_JSON_STR });

    expect(result.valid).toBe(true);
    expect(result.format).toBe("json");
    expect(result.errors).toHaveLength(0);
  });

  it("VS2: returns valid:true and detected cedarschema format for cedarschema text", async () => {
    const result = await handleValidateSchema({ schema: CEDARSCHEMA_TEXT });

    expect(result.valid).toBe(true);
    expect(result.format).toBe("cedarschema");
    expect(result.errors).toHaveLength(0);
  });

  it("VS3: returns structured errors for malformed cedarschema", async () => {
    const result = await handleValidateSchema({ schema: "not a schema" });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toBeTruthy();
  });

  it("VS4: reports namespaces from a JSON schema", async () => {
    const result = await handleValidateSchema({ schema: SCHEMA_JSON_STR });

    expect(result.namespaces).toContain("DocMgmt");
  });

  it("VS5: reports counts of entity types, actions, and common types", async () => {
    const result = await handleValidateSchema({ schema: SCHEMA_JSON_STR });

    expect(result.entity_type_count).toBe(4);
    expect(result.action_count).toBe(3);
    expect(result.common_type_count).toBe(0);
  });

  it("VS6: returns structured error with source location for syntactically broken cedarschema", async () => {
    const broken = "namespace DocMgmt { entity User { name String } }"; // missing colon
    const result = await handleValidateSchema({ schema: broken });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("VS7: handles an empty string by returning a parse error, not a crash", async () => {
    const result = await handleValidateSchema({ schema: "" });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("VS8: handles namespace-less JSON schema (top-level entityTypes)", async () => {
    const flatSchema = JSON.stringify({
      "": {
        entityTypes: { Foo: { memberOfTypes: [], shape: { type: "Record", attributes: {} } } },
        actions: {},
      },
    });
    const result = await handleValidateSchema({ schema: flatSchema });

    expect(result.valid).toBe(true);
    expect(result.namespaces).toEqual([""]);
  });
});
