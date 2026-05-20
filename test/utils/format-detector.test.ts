import { describe, it, expect } from "vitest";
import {
  detectFormat,
  normalizeEntities,
  normalizePrincipalRef,
  unwrapAvpAttributes,
} from "../../src/utils/format-detector.js";

// ─── Dataset A: Cedar/WASM format (baseline) ─────────────────────────────────

const CEDAR_ENTITIES = [
  {
    uid: { type: "DocMgmt::User", id: "alice" },
    attrs: { name: "Alice", email: "alice@example.com" },
    parents: [{ type: "DocMgmt::Role", id: "admin" }],
  },
  {
    uid: { type: "DocMgmt::Role", id: "admin" },
    attrs: {},
    parents: [],
  },
];

// ─── Dataset B: AVP entity format ────────────────────────────────────────────
// Spike proven: identifier key → hard failure. attributes key + typed values → silent wrong.

const AVP_ENTITIES = [
  {
    identifier: { entity_type: "DocMgmt::User", entity_id: "alice" },
    attributes: {
      name: { string: "Alice" },
      email: { string: "alice@example.com" },
    },
    parents: [{ entity_type: "DocMgmt::Role", entity_id: "admin" }],
  },
  {
    identifier: { entity_type: "DocMgmt::Role", entity_id: "admin" },
    attributes: {},
    parents: [],
  },
];

// ─── Dataset C: AVP entities with all three attribute types ──────────────────

const AVP_ENTITIES_ALL_TYPES = [
  {
    identifier: { entity_type: "SaaS::User", entity_id: "alice" },
    attributes: {
      name: { string: "Alice" },
      age: { long: 30 },
      active: { boolean: true },
    },
    parents: [],
  },
];

// ─── Dataset D: Cedar CLI format (uid.__entity) — works natively, no conversion ───

const CEDAR_CLI_ENTITIES = [
  {
    uid: { __entity: { type: "DocMgmt::User", id: "alice" } },
    attrs: { name: "Alice" },
    parents: [{ type: "DocMgmt::Role", id: "admin" }],
  },
];

// ─── Dataset E: AVP principal/action/resource ────────────────────────────────
// Spike proven: { entity_type, entity_id } → hard failure on isAuthorized.

const AVP_PRINCIPAL = { entity_type: "DocMgmt::User", entity_id: "alice" };
const AVP_ACTION = { action_type: "DocMgmt::Action", action_id: "READ" };
const AVP_RESOURCE = { entity_type: "DocMgmt::Document", entity_id: "doc-1" };

// ─── Dataset F: Cedar principal/action/resource (string) ─────────────────────

const CEDAR_PRINCIPAL = 'DocMgmt::User::"alice"';
const CEDAR_ACTION = 'DocMgmt::Action::"READ"';
const CEDAR_RESOURCE = 'DocMgmt::Document::"doc-1"';

// ─── Dataset G: Edge case — Cedar Record that LOOKS like AVP ─────────────────
// A real Cedar Record attribute with multiple fields should NOT be detected as AVP.

const CEDAR_RECORD_ENTITY = [
  {
    uid: { type: "MyApp::Config", id: "cfg-1" },
    attrs: {
      settings: { theme: "dark", lang: "en" },    // Record with 2+ fields → NOT AVP
      meta: { string: "value", extra: "stuff" },  // Record with 2 fields (one named "string") → NOT AVP
    },
    parents: [],
  },
];

// ─── Dataset H: AVP entities with integer and boolean attributes ──────────────

const AVP_ENTITY_MIXED_TYPES = {
  identifier: { entity_type: "SaaS::User", entity_id: "bob" },
  attributes: {
    score: { long: 42 },
    verified: { boolean: true },
    plan: { string: "pro" },
  },
  parents: [],
};

// ─────────────────────────────────────────────────────────────────────────────

describe("detectFormat", () => {
  it("detects Cedar/WASM format from clean entities", () => {
    const result = detectFormat(CEDAR_ENTITIES, CEDAR_PRINCIPAL, CEDAR_ACTION, CEDAR_RESOURCE);
    expect(result.format).toBe("cedar");
    expect(result.confidence).toBe("high");
  });

  it("detects AVP format from identifier key in entities", () => {
    const result = detectFormat(AVP_ENTITIES, CEDAR_PRINCIPAL, CEDAR_ACTION, CEDAR_RESOURCE);
    expect(result.format).toBe("avp");
    expect(result.confidence).toBe("high");
  });

  it("detects AVP format from typed attribute values (string/long/boolean wrappers)", () => {
    const result = detectFormat(AVP_ENTITIES_ALL_TYPES, CEDAR_PRINCIPAL, CEDAR_ACTION, CEDAR_RESOURCE);
    expect(result.format).toBe("avp");
    expect(result.confidence).toBe("high");
  });

  it("detects AVP format from structured principal object", () => {
    const result = detectFormat(CEDAR_ENTITIES, AVP_PRINCIPAL, AVP_ACTION, AVP_RESOURCE);
    expect(result.format).toBe("avp");
    expect(result.confidence).toBe("high");
  });

  it("detects cedar_cli format from __entity wrapper on uid", () => {
    const result = detectFormat(CEDAR_CLI_ENTITIES, CEDAR_PRINCIPAL, CEDAR_ACTION, CEDAR_RESOURCE);
    expect(result.format).toBe("cedar_cli");
    // Note: cedar_cli passes through without conversion — WASM accepts both uid forms
  });

  it("does NOT misdetect Cedar Record attributes with 2+ fields as AVP", () => {
    const result = detectFormat(CEDAR_RECORD_ENTITY, CEDAR_PRINCIPAL, CEDAR_ACTION, CEDAR_RESOURCE);
    expect(result.format).toBe("cedar");
  });

  it("detects AVP when entity has both identifier key AND typed attrs", () => {
    const result = detectFormat([AVP_ENTITY_MIXED_TYPES], CEDAR_PRINCIPAL, CEDAR_ACTION, CEDAR_RESOURCE);
    expect(result.format).toBe("avp");
    expect(result.confidence).toBe("high");
  });
});

describe("normalizeEntities", () => {
  it("passes Cedar entities through unchanged", () => {
    const result = normalizeEntities(CEDAR_ENTITIES, "cedar");
    expect(result[0]!.uid).toEqual({ type: "DocMgmt::User", id: "alice" });
    expect(result[0]!.attrs).toEqual({ name: "Alice", email: "alice@example.com" });
    expect(result[0]!.parents).toEqual([{ type: "DocMgmt::Role", id: "admin" }]);
  });

  it("converts AVP identifier → uid", () => {
    const result = normalizeEntities(AVP_ENTITIES, "avp");
    expect(result[0]!.uid).toEqual({ type: "DocMgmt::User", id: "alice" });
  });

  it("converts AVP attributes key → attrs", () => {
    const result = normalizeEntities(AVP_ENTITIES, "avp");
    expect(result[0]!.attrs).toBeDefined();
    expect((result[0]!.attrs as Record<string, unknown>)["name"]).toBe("Alice");
  });

  it("unwraps AVP typed string values", () => {
    const result = normalizeEntities(AVP_ENTITIES, "avp");
    expect((result[0]!.attrs as Record<string, unknown>)["name"]).toBe("Alice");
    expect((result[0]!.attrs as Record<string, unknown>)["email"]).toBe("alice@example.com");
  });

  it("unwraps AVP typed long values", () => {
    const result = normalizeEntities(AVP_ENTITIES_ALL_TYPES, "avp");
    expect((result[0]!.attrs as Record<string, unknown>)["age"]).toBe(30);
  });

  it("unwraps AVP typed boolean values", () => {
    const result = normalizeEntities(AVP_ENTITIES_ALL_TYPES, "avp");
    expect((result[0]!.attrs as Record<string, unknown>)["active"]).toBe(true);
  });

  it("converts AVP parent entity_type/entity_id → type/id", () => {
    const result = normalizeEntities(AVP_ENTITIES, "avp");
    expect(result[0]!.parents[0]).toEqual({ type: "DocMgmt::Role", id: "admin" });
  });

  it("passes Cedar CLI entities through unchanged (WASM accepts __entity natively)", () => {
    const result = normalizeEntities(CEDAR_CLI_ENTITIES, "cedar_cli");
    expect((result[0]!.uid as Record<string, unknown>)["__entity"]).toBeDefined();
  });

  it("does NOT unwrap Cedar Record attributes with multiple keys", () => {
    const result = normalizeEntities(CEDAR_RECORD_ENTITY, "cedar");
    expect((result[0]!.attrs as Record<string, unknown>)["settings"]).toEqual({ theme: "dark", lang: "en" });
  });
});

describe("normalizePrincipalRef", () => {
  it("parses Cedar string literal to { type, id }", () => {
    const result = normalizePrincipalRef('DocMgmt::User::"alice"');
    expect(result).toEqual({ type: "DocMgmt::User", id: "alice" });
  });

  it("converts AVP entity_type/entity_id object to { type, id }", () => {
    const result = normalizePrincipalRef({ entity_type: "DocMgmt::User", entity_id: "alice" });
    expect(result).toEqual({ type: "DocMgmt::User", id: "alice" });
  });

  it("converts AVP action_type/action_id object to { type, id }", () => {
    const result = normalizePrincipalRef({ action_type: "DocMgmt::Action", action_id: "READ" });
    expect(result).toEqual({ type: "DocMgmt::Action", id: "READ" });
  });

  it("passes { type, id } through unchanged", () => {
    const result = normalizePrincipalRef({ type: "DocMgmt::User", id: "alice" });
    expect(result).toEqual({ type: "DocMgmt::User", id: "alice" });
  });

  it("returns error object for unknown formats", () => {
    const result = normalizePrincipalRef({ unknown_key: "value" });
    expect("error" in result).toBe(true);
  });
});

describe("unwrapAvpAttributes", () => {
  it("unwraps string wrapper", () => {
    const result = unwrapAvpAttributes({ name: { string: "Alice" } });
    expect(result["name"]).toBe("Alice");
  });

  it("unwraps long wrapper", () => {
    const result = unwrapAvpAttributes({ score: { long: 42 } });
    expect(result["score"]).toBe(42);
  });

  it("unwraps boolean wrapper", () => {
    const result = unwrapAvpAttributes({ active: { boolean: true } });
    expect(result["active"]).toBe(true);
  });

  it("leaves raw string values unchanged", () => {
    const result = unwrapAvpAttributes({ name: "Alice" });
    expect(result["name"]).toBe("Alice");
  });

  it("leaves raw number values unchanged", () => {
    const result = unwrapAvpAttributes({ count: 5 });
    expect(result["count"]).toBe(5);
  });

  it("does NOT unwrap Cedar Record with multiple keys", () => {
    const result = unwrapAvpAttributes({ config: { theme: "dark", lang: "en" } });
    expect(result["config"]).toEqual({ theme: "dark", lang: "en" });
  });

  it("does NOT unwrap object with 'string' key alongside other keys", () => {
    const result = unwrapAvpAttributes({ meta: { string: "val", extra: "other" } });
    expect(result["meta"]).toEqual({ string: "val", extra: "other" });
  });

  it("handles empty attrs", () => {
    const result = unwrapAvpAttributes({});
    expect(result).toEqual({});
  });
});
