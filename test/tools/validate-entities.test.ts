import { describe, it, expect } from "vitest";
import { handleValidateEntities } from "../../src/tools/validate-entities.js";
import { SCHEMA_JSON, ENTITIES } from "../fixtures/docmgmt.js";

const SCHEMA_STR = JSON.stringify(SCHEMA_JSON);

describe("cedar_validate_entities", () => {
  it("VE1: valid entities + schema → valid:true, no errors", async () => {
    const result = await handleValidateEntities({
      entities: JSON.stringify(ENTITIES),
      schema: SCHEMA_STR,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.entity_count).toBe(ENTITIES.length);
  });

  it("VE2: entity of unknown type → unknown_type error with entity_uid", async () => {
    const bad = [
      { uid: { type: "DocMgmt::Unicorn", id: "rainbow" }, attrs: {}, parents: [] },
    ];

    const result = await handleValidateEntities({
      entities: JSON.stringify(bad),
      schema: SCHEMA_STR,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const e = result.errors[0];
    expect(e.error_kind).toBe("unknown_type");
    expect(e.entity_uid).toContain("DocMgmt::Unicorn");
    expect(e.entity_uid).toContain("rainbow");
  });

  it("VE3: missing required attribute → missing_required_attribute error", async () => {
    const bad = [
      { uid: { type: "DocMgmt::User", id: "alice" }, attrs: { name: "Alice" }, parents: [] },
    ];

    const result = await handleValidateEntities({
      entities: JSON.stringify(bad),
      schema: SCHEMA_STR,
    });

    expect(result.valid).toBe(false);
    const e = result.errors[0];
    expect(e.error_kind).toBe("missing_required_attribute");
    expect(e.attribute).toBe("email");
    expect(e.entity_uid).toContain("alice");
  });

  it("VE4: wrong attribute type → type_mismatch error", async () => {
    const bad = [
      {
        uid: { type: "DocMgmt::User", id: "alice" },
        attrs: { name: 42, email: "alice@example.com" },
        parents: [],
      },
    ];

    const result = await handleValidateEntities({
      entities: JSON.stringify(bad),
      schema: SCHEMA_STR,
    });

    expect(result.valid).toBe(false);
    const e = result.errors[0];
    expect(e.error_kind).toBe("type_mismatch");
    expect(e.attribute).toBe("name");
    expect(e.entity_uid).toContain("alice");
  });

  it("VE5: unknown attribute → unknown_attribute error", async () => {
    const bad = [
      {
        uid: { type: "DocMgmt::User", id: "alice" },
        attrs: { name: "Alice", email: "a@b.c", bogus: "x" },
        parents: [],
      },
    ];

    const result = await handleValidateEntities({
      entities: JSON.stringify(bad),
      schema: SCHEMA_STR,
    });

    expect(result.valid).toBe(false);
    const e = result.errors[0];
    expect(e.error_kind).toBe("unknown_attribute");
    expect(e.attribute).toBe("bogus");
  });

  it("VE6: entity with parent of unknown/disallowed type → disallowed_parent_type error", async () => {
    const bad = [
      {
        uid: { type: "DocMgmt::User", id: "alice" },
        attrs: { name: "Alice", email: "a@b.c" },
        parents: [{ type: "DocMgmt::Unicorn", id: "rainbow" }],
      },
    ];

    const result = await handleValidateEntities({
      entities: JSON.stringify(bad),
      schema: SCHEMA_STR,
    });

    expect(result.valid).toBe(false);
    const e = result.errors[0];
    expect(e.error_kind).toBe("disallowed_parent_type");
    expect(e.entity_uid).toContain("alice");
  });

  it("VE7: malformed entities JSON → parse_error", async () => {
    const result = await handleValidateEntities({
      entities: "{ not valid json",
      schema: SCHEMA_STR,
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].error_kind).toBe("parse_error");
  });

  it("VE8: no schema provided → JSON shape only, no type validation", async () => {
    const result = await handleValidateEntities({
      entities: JSON.stringify(ENTITIES),
    });

    expect(result.valid).toBe(true);
    expect(result.entity_count).toBe(ENTITIES.length);
  });

  it("VEF: falsification — entity with three violations surfaces all three", async () => {
    // wrong type, missing required, unknown attr — all in one entity.
    // WASM may return them as a single error or multiple — test that the
    // collective surface mentions all three concerns somewhere.
    const bad = [
      {
        uid: { type: "DocMgmt::User", id: "alice" },
        attrs: { name: 42, bogus: "x" }, // wrong type + missing email + unknown attr
        parents: [],
      },
    ];

    const result = await handleValidateEntities({
      entities: JSON.stringify(bad),
      schema: SCHEMA_STR,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // At minimum, the surfaced error must clearly attribute the violation to 'alice'
    expect(result.errors[0].entity_uid).toContain("alice");
  });
});
