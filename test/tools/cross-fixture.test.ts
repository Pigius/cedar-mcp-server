// Cross-fixture smoke tests: exercise the tool surface against Dataset 2
// (Insurance ABAC) to confirm tools aren't locked to Dataset 1 assumptions.
import { describe, it, expect } from "vitest";
import { handleAuthorize } from "../../src/tools/authorize.js";
import { handleValidate } from "../../src/tools/validate.js";
import { handleValidateSchema } from "../../src/tools/validate-schema.js";
import { handleValidateEntities } from "../../src/tools/validate-entities.js";
import { handleDiffSchema } from "../../src/tools/diff-schema.js";
import {
  POLICIES,
  SCHEMA_JSON,
  ENTITIES,
} from "../fixtures/multitenant.js";
import { SCHEMA_JSON as DOCMGMT_SCHEMA } from "../fixtures/docmgmt.js";

const SCHEMA_STR = JSON.stringify(SCHEMA_JSON);

// ---------------------------------------------------------------------------
// cedar_validate_schema — Dataset 2 schema is well-formed
// ---------------------------------------------------------------------------
describe("cedar_validate_schema — Insurance (Dataset 2)", () => {
  it("CF-VS1: Insurance JSON schema is valid", async () => {
    const result = await handleValidateSchema({ schema: SCHEMA_STR });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.namespaces).toContain("Insurance");
  });

  it("CF-VS2: reports correct entity type and action counts", async () => {
    const result = await handleValidateSchema({ schema: SCHEMA_STR });
    // Identity, Role, Policy = 3 entity types; CREATE, READ, UPDATE = 3 actions
    expect(result.entity_type_count).toBe(3);
    expect(result.action_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// cedar_validate — policies validate cleanly against Dataset 2 schema
// ---------------------------------------------------------------------------
describe("cedar_validate — Insurance policies (Dataset 2)", () => {
  it("CF-V1: all Insurance policies are valid against the schema", async () => {
    const result = await handleValidate({ policies: POLICIES, schema: SCHEMA_STR });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("CF-V2: policy referencing a nonexistent attribute is invalid", async () => {
    const bad = `permit(principal, action, resource) when { resource.nonexistent == "x" };`;
    const result = await handleValidate({ policies: bad, schema: SCHEMA_STR });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// cedar_validate_entities — Dataset 2 entity set is valid
// ---------------------------------------------------------------------------
describe("cedar_validate_entities — Insurance entities (Dataset 2)", () => {
  it("CF-VE1: full Insurance entity set is valid against its schema", async () => {
    const result = await handleValidateEntities({
      entities: JSON.stringify(ENTITIES),
      schema: SCHEMA_STR,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.entity_count).toBe(ENTITIES.length);
  });

  it("CF-VE2: optional insurer attribute absent on POL-004 does not cause a validation error", async () => {
    // POL-004 intentionally has no `insurer` field — must still be valid (required: false)
    const pol004 = ENTITIES.filter((e) => e.uid.id === "POL-004");
    const result = await handleValidateEntities({
      entities: JSON.stringify(pol004),
      schema: SCHEMA_STR,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cedar_authorize — ABAC decisions against Dataset 2
// ---------------------------------------------------------------------------
describe("cedar_authorize — Insurance ABAC (Dataset 2)", () => {
  it("CF-A1: tenant-a is allowed READ on POL-001 (matching vertical + business_unit)", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'Insurance::Identity::"tenant-a"',
      action: 'Insurance::Action::"READ"',
      resource: 'Insurance::Policy::"POL-001"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Allow");
    expect(result.errors).toHaveLength(0);
  });

  it("CF-A2: tenant-a is denied READ on POL-002 (wrong business_unit)", async () => {
    // POL-002 vertical=commercial_landlord — not in tenant-a permit list
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'Insurance::Identity::"tenant-a"',
      action: 'Insurance::Action::"READ"',
      resource: 'Insurance::Policy::"POL-002"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Deny");
  });

  it("CF-A3: tenant-b READ denied on POL-004 — resource has no insurer attr", async () => {
    // POL-004 has no insurer; `resource has insurer` is false → policy doesn't apply
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'Insurance::Identity::"tenant-b"',
      action: 'Insurance::Action::"READ"',
      resource: 'Insurance::Policy::"POL-004"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Deny");
  });

  it("CF-A4: unknown-client READ denied — default deny, no policy matches", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'Insurance::Identity::"unknown-client"',
      action: 'Insurance::Action::"READ"',
      resource: 'Insurance::Policy::"POL-001"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Deny");
    expect(result.determining_policies).toHaveLength(0);
  });

  it("CF-A5: tenant-d CREATE allowed", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'Insurance::Identity::"tenant-d"',
      action: 'Insurance::Action::"CREATE"',
      resource: 'Insurance::Policy::"POL-001"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Allow");
  });

  it("CF-A6: tenant-d UPDATE denied — not in permitted action list", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'Insurance::Identity::"tenant-d"',
      action: 'Insurance::Action::"UPDATE"',
      resource: 'Insurance::Policy::"POL-001"',
      entities: JSON.stringify(ENTITIES),
    });
    expect(result.decision).toBe("Deny");
  });
});

// ---------------------------------------------------------------------------
// cedar_diff_schema — cross-dataset diff (Dataset 1 vs Dataset 2)
// ---------------------------------------------------------------------------
describe("cedar_diff_schema — DocMgmt vs Insurance (cross-fixture)", () => {
  it("CF-DS1: diffing two distinct namespaces reports both namespaces as added/removed", async () => {
    const result = await handleDiffSchema({
      blue: JSON.stringify(DOCMGMT_SCHEMA),
      green: SCHEMA_STR,
    });
    // DocMgmt was in blue → removed; Insurance is in green → added
    expect(result.namespaces_removed).toContain("DocMgmt");
    expect(result.namespaces_added).toContain("Insurance");
    expect(result.risk_level).toBe("breaking");
  });
});
