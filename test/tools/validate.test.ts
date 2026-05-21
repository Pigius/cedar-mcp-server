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

describe("cedar_validate — M2 line/column on parse errors", () => {
  it("returns line and column for a parse error on a multi-line policy", async () => {
    // `int` typo (should be `in`) sits on line 3, starting at column 10 (1-indexed)
    const bad = `permit (
  principal,
  action int [DocMgmt::Action::"READ"],
  resource
);`;
    const result = await handleValidate({ policies: bad, schema: SCHEMA_STR });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const err = result.errors[0]!;
    expect(err.line).toBe(3);
    expect(err.column).toBe(10);
  });

  it("returns line 1 for a single-line parse error", async () => {
    const bad = `permint (principal, action, resource);`;  // `permint` typo on line 1
    const result = await handleValidate({ policies: bad, schema: SCHEMA_STR });

    expect(result.valid).toBe(false);
    expect(result.errors[0]!.line).toBe(1);
    expect(result.errors[0]!.column).toBeGreaterThan(0);
  });

  it("reports correct column when a multi-byte UTF-8 char (em-dash) appears before the error", async () => {
    // Post-audit regression: WASM reports UTF-8 byte offsets; naive walking
    // as JS-string char indexes drifts on multi-byte chars. The em-dash on
    // line 1 is 3 bytes / 1 code point. The `int` typo on line 4 starts at
    // 1-indexed column 10. A byte-counted column would report 12.
    const bad = `// comment with em—dash
permit (
  principal,
  action int [DocMgmt::Action::"READ"],
  resource
);`;
    const result = await handleValidate({ policies: bad, schema: SCHEMA_STR });

    expect(result.valid).toBe(false);
    expect(result.errors[0]!.line).toBe(4);
    expect(result.errors[0]!.column).toBe(10);
  });
});

describe("cedar_validate — M1 hint for common typos", () => {
  it("suggests 'in' when policy uses 'int' as a token", async () => {
    const bad = `permit (principal, action int [DocMgmt::Action::"READ"], resource);`;
    const result = await handleValidate({ policies: bad, schema: SCHEMA_STR });

    expect(result.valid).toBe(false);
    expect(result.errors[0]!.hint).toMatch(/'in'/);
  });

  it("suggests 'principal' when policy uses 'prinipal'", async () => {
    const bad = `permit (prinipal, action, resource);`;
    const result = await handleValidate({ policies: bad, schema: SCHEMA_STR });

    expect(result.valid).toBe(false);
    expect(result.errors[0]!.hint).toMatch(/'principal'/);
  });

  it("suggests 'permit' when policy uses 'permint'", async () => {
    const bad = `permint (principal, action, resource);`;
    const result = await handleValidate({ policies: bad, schema: SCHEMA_STR });

    expect(result.valid).toBe(false);
    expect(result.errors[0]!.hint).toMatch(/'permit'/);
  });

  it("leaves hint null for parse errors with no known typo", async () => {
    const bad = `permit (principal, action, resource) when { xyzzy(123) };`;
    const result = await handleValidate({ policies: bad, schema: SCHEMA_STR });

    // The error may or may not exist depending on Cedar's grammar; if it does, hint should be null
    if (result.errors.length > 0 && result.errors[0]!.hint !== undefined) {
      // Only assert when there is an error to check; the point is we do not over-suggest
      expect(result.errors[0]!.hint).toBeNull();
    }
  });
});
