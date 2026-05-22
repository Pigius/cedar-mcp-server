import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleValidate } from "../../src/tools/validate.js";
import { storeManager } from "../../src/resources/store-manager.js";
import { POLICIES, SCHEMA_JSON } from "../fixtures/docmgmt.js";

const SCHEMA_STR = JSON.stringify(SCHEMA_JSON);

// Minimal Cedar schema reused for the 10d auto-discovery fixtures below.
const DOCMGMT_SCHEMA_CEDARSCHEMA = `namespace DocMgmt {
  entity User in [Role] = { name: String, email: String };
  entity Role;
  entity Document in [Folder] = { owner: String, classification: String };
  entity Folder;
  action READ appliesTo { principal: [User], resource: [Document], context: {} };
  action WRITE appliesTo { principal: [User], resource: [Document], context: {} };
  action DELETE appliesTo { principal: [User], resource: [Document], context: {} };
}`;

function makeAutoDiscoveryStore(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cedar-validate-auto-${name}-`));
  mkdirSync(join(dir, "policies"), { recursive: true });
  writeFileSync(join(dir, "schema.cedarschema"), DOCMGMT_SCHEMA_CEDARSCHEMA);
  return dir;
}

describe("cedar_validate", () => {
  it("returns valid for correct policies against schema", async () => {
    const result = await handleValidate({ policies: POLICIES, schema: SCHEMA_STR });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.validation_mode).toBe("syntax_and_schema");
  });

  it("returns invalid for a policy referencing a non-existent attribute", async () => {
    const bad = `permit(principal, action, resource) when { resource.nonexistent == "x" };`;
    const result = await handleValidate({ policies: bad, schema: SCHEMA_STR });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain("nonexistent");
    expect(result.validation_mode).toBe("syntax_and_schema");
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

describe("cedar_validate — 10a syntax-only mode (no schema)", () => {
  it("returns parse error with typo hint when schema is omitted and policy contains 'prinicpal'", async () => {
    const bad = `permit (prinicpal in MyApp::Role::"admin", action, resource);`;
    const result = await handleValidate({ policies: bad });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.hint).toMatch(/Did you mean 'principal'\?/);
    expect(result.errors[0]!.line).toBe(1);
    expect(result.validation_mode).toBe("syntax_only");
  });

  it("returns valid for a correctly parsed policy when schema is omitted", async () => {
    const ok = `permit (principal, action, resource);`;
    const result = await handleValidate({ policies: ok });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.policy_count).toBe(1);
    expect(result.validation_mode).toBe("syntax_only");
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

describe("cedar_validate — 10d auto-discovery", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    // Reset the singleton store manager so per-test state never leaks. Also
    // tear down the temp workspace directories created during the test.
    storeManager.loadFromRoots([]);
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pulls the schema from the single loaded store when input.schema is omitted", async () => {
    const storePath = makeAutoDiscoveryStore("single");
    tempDirs.push(storePath);
    storeManager.loadFromRoots([{ uri: `file://${storePath}`, name: "workspace" }]);

    const result = await handleValidate({ policies: POLICIES });

    expect(result.valid).toBe(true);
    expect(result.validation_mode).toBe("syntax_and_schema");
    expect(result.auto_discovered).toEqual({ schema_from: "workspace" });
  });

  it("honors an explicit store parameter even when multiple stores are loaded", async () => {
    const blue = makeAutoDiscoveryStore("blue");
    const green = makeAutoDiscoveryStore("green");
    tempDirs.push(blue, green);
    storeManager.loadFromRoots([
      { uri: `file://${blue}`, name: "blue" },
      { uri: `file://${green}`, name: "green" },
    ]);

    const result = await handleValidate({ policies: POLICIES, store: "green" });

    expect(result.valid).toBe(true);
    expect(result.validation_mode).toBe("syntax_and_schema");
    expect(result.auto_discovered).toEqual({ schema_from: "green" });
  });

  it("returns an ambiguity error when multiple stores are loaded and no store is passed", async () => {
    const blue = makeAutoDiscoveryStore("blue");
    const green = makeAutoDiscoveryStore("green");
    tempDirs.push(blue, green);
    storeManager.loadFromRoots([
      { uri: `file://${blue}`, name: "blue" },
      { uri: `file://${green}`, name: "green" },
    ]);

    const result = await handleValidate({ policies: POLICIES });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/Multiple stores are loaded/);
    expect(result.errors[0]!.message).toContain("blue");
    expect(result.errors[0]!.message).toContain("green");
    expect(result.errors[0]!.message).toMatch(/Pass store/);
    // Stays in syntax_only because we never picked a schema to type-check against.
    expect(result.validation_mode).toBe("syntax_only");
  });
});

describe("cedar_validate — 11c explicit validation_mode opt-in", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    storeManager.loadFromRoots([]);
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validation_mode='auto' (default explicit) behaves like the existing auto-discovery path", async () => {
    const storePath = makeAutoDiscoveryStore("workspace-auto");
    tempDirs.push(storePath);
    storeManager.loadFromRoots([{ uri: `file://${storePath}`, name: "workspace-auto" }]);

    const result = await handleValidate({ policies: POLICIES, validation_mode: "auto" });

    expect(result.valid).toBe(true);
    expect(result.validation_mode).toBe("syntax_and_schema");
    expect(result.auto_discovered).toEqual({ schema_from: "workspace-auto" });
  });

  it("validation_mode='syntax_only' forces parser-only and skips workspace auto-discovery even when a store is loaded", async () => {
    const storePath = makeAutoDiscoveryStore("workspace-bypass");
    tempDirs.push(storePath);
    storeManager.loadFromRoots([{ uri: `file://${storePath}`, name: "workspace-bypass" }]);

    const result = await handleValidate({
      policies: `permit (principal, action, resource);`,
      validation_mode: "syntax_only",
    });

    expect(result.valid).toBe(true);
    expect(result.validation_mode).toBe("syntax_only");
    // Critical: no auto_discovered field — the store was loaded but we explicitly bypassed it.
    expect(result.auto_discovered).toBeUndefined();
  });

  it("validation_mode='syntax_only' ignores a schema passed inline (parser-only on demand)", async () => {
    const result = await handleValidate({
      policies: `permit (principal, action, resource);`,
      schema: SCHEMA_STR,
      validation_mode: "syntax_only",
    });

    expect(result.valid).toBe(true);
    expect(result.validation_mode).toBe("syntax_only");
    expect(result.auto_discovered).toBeUndefined();
  });

  it("validation_mode='syntax_and_schema' with an inline schema runs full type-check", async () => {
    const result = await handleValidate({
      policies: POLICIES,
      schema: SCHEMA_STR,
      validation_mode: "syntax_and_schema",
    });

    expect(result.valid).toBe(true);
    expect(result.validation_mode).toBe("syntax_and_schema");
  });

  it("validation_mode='syntax_and_schema' resolves from the workspace when no inline schema was provided", async () => {
    const storePath = makeAutoDiscoveryStore("workspace-explicit");
    tempDirs.push(storePath);
    storeManager.loadFromRoots([{ uri: `file://${storePath}`, name: "workspace-explicit" }]);

    const result = await handleValidate({
      policies: POLICIES,
      validation_mode: "syntax_and_schema",
    });

    expect(result.valid).toBe(true);
    expect(result.validation_mode).toBe("syntax_and_schema");
    expect(result.auto_discovered).toEqual({ schema_from: "workspace-explicit" });
  });

  it("validation_mode='syntax_and_schema' with no schema available returns a clear error (not a silent fall-through to syntax_only)", async () => {
    const result = await handleValidate({
      policies: `permit (principal, action, resource);`,
      validation_mode: "syntax_and_schema",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/syntax_and_schema/);
    expect(result.errors[0]!.message).toMatch(/schema/);
    // The response's validation_mode reflects what the caller asked for, not what got run.
    expect(result.validation_mode).toBe("syntax_and_schema");
  });
});
