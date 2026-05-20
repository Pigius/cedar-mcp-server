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

// ─── New SDK variant datasets ─────────────────────────────────────────────────

// Dataset I: Python / JS SDK v3 format (camelCase structural keys)
const CAMEL_CASE_ENTITIES = [
  {
    identifier: { entityType: "DocMgmt::User", entityId: "alice" },
    attributes: { name: { string: "Alice" } },
    parents: [{ entityType: "DocMgmt::Role", entityId: "admin" }],
  },
  {
    identifier: { entityType: "DocMgmt::Role", entityId: "admin" },
    attributes: {},
    parents: [],
  },
];

const CAMEL_CASE_PRINCIPAL = { entityType: "DocMgmt::User", entityId: "alice" };
const CAMEL_CASE_ACTION = { actionType: "DocMgmt::Action", actionId: "READ" };
const CAMEL_CASE_RESOURCE = { entityType: "DocMgmt::Document", entityId: "doc-1" };

// Dataset J: Official API / AWS Console format (PascalCase everything)
const PASCAL_CASE_ENTITIES = [
  {
    Identifier: { EntityType: "DocMgmt::User", EntityId: "alice" },
    Attributes: {
      name: { String: "Alice" },
      age: { Long: 30 },
      active: { Boolean: true },
    },
    Parents: [{ EntityType: "DocMgmt::Role", EntityId: "admin" }],
  },
  {
    Identifier: { EntityType: "DocMgmt::Role", EntityId: "admin" },
    Attributes: {},
    Parents: [],
  },
];

const PASCAL_CASE_PRINCIPAL = { EntityType: "DocMgmt::User", EntityId: "alice" };
const PASCAL_CASE_ACTION = { ActionType: "DocMgmt::Action", ActionId: "READ" };
const PASCAL_CASE_RESOURCE = { EntityType: "DocMgmt::Document", EntityId: "doc-1" };

// Dataset K: entityIdentifier in attribute values (camelCase — JS/Python SDK)
const ENTITY_REF_IN_ATTRS = [
  {
    identifier: { entityType: "SaaS::Document", entityId: "doc-1" },
    attributes: {
      owner: {
        entityIdentifier: { entityType: "SaaS::User", entityId: "alice" },
      },
    },
    parents: [],
  },
];

// Dataset L: EntityIdentifier in attribute values (PascalCase — official API)
const ENTITY_REF_PASCAL = [
  {
    Identifier: { EntityType: "SaaS::Document", EntityId: "doc-1" },
    Attributes: {
      owner: {
        EntityIdentifier: { EntityType: "SaaS::User", EntityId: "alice" },
      },
    },
    Parents: [],
  },
];

// Dataset M: Set and Record attribute types
const SET_RECORD_ENTITIES = [
  {
    identifier: { entityType: "MyApp::User", entityId: "alice" },
    attributes: {
      tags: { set: [{ string: "admin" }, { string: "ops" }] },
      config: { record: { theme: { string: "dark" }, lang: { string: "en" } } },
    },
    parents: [],
  },
];

// Dataset N: Extension types (ipaddr, decimal, datetime, duration)
const EXTENSION_ATTR_ENTITIES = [
  {
    identifier: { entityType: "MyApp::Device", entityId: "device-1" },
    attributes: {
      ipAddress: { ipaddr: "192.168.1.1" },
      balance: { decimal: "1.5" },
      createdAt: { datetime: "2024-10-15T11:35:00Z" },
      ttl: { duration: "1h30m" },
    },
    parents: [],
  },
];

describe("detectFormat — camelCase (Python/JS SDK)", () => {
  it("detects AVP format from camelCase identifier.entityType", () => {
    const r = detectFormat(CAMEL_CASE_ENTITIES, CAMEL_CASE_PRINCIPAL, CAMEL_CASE_ACTION, CAMEL_CASE_RESOURCE);
    expect(r.format).toBe("avp");
    expect(r.confidence).toBe("high");
  });

  it("detects AVP format from camelCase principal with no entities check", () => {
    const r = detectFormat([], CAMEL_CASE_PRINCIPAL, CAMEL_CASE_ACTION, CAMEL_CASE_RESOURCE);
    expect(r.format).toBe("avp");
  });
});

describe("detectFormat — PascalCase (official API / AWS console)", () => {
  it("detects AVP format from PascalCase Identifier.EntityType", () => {
    const r = detectFormat(PASCAL_CASE_ENTITIES, PASCAL_CASE_PRINCIPAL, PASCAL_CASE_ACTION, PASCAL_CASE_RESOURCE);
    expect(r.format).toBe("avp");
    expect(r.confidence).toBe("high");
  });

  it("detects AVP from PascalCase principal alone", () => {
    const r = detectFormat([], PASCAL_CASE_PRINCIPAL, PASCAL_CASE_ACTION, PASCAL_CASE_RESOURCE);
    expect(r.format).toBe("avp");
  });
});

describe("normalizeEntities — camelCase AVP", () => {
  it("converts camelCase identifier → uid with { type, id }", () => {
    const result = normalizeEntities(CAMEL_CASE_ENTITIES, "avp");
    expect(result[0]!.uid).toEqual({ type: "DocMgmt::User", id: "alice" });
  });

  it("converts camelCase parents entityType/entityId → type/id", () => {
    const result = normalizeEntities(CAMEL_CASE_ENTITIES, "avp");
    expect(result[0]!.parents[0]).toEqual({ type: "DocMgmt::Role", id: "admin" });
  });
});

describe("normalizeEntities — PascalCase AVP", () => {
  it("converts PascalCase Identifier → uid with { type, id }", () => {
    const result = normalizeEntities(PASCAL_CASE_ENTITIES, "avp");
    expect(result[0]!.uid).toEqual({ type: "DocMgmt::User", id: "alice" });
  });

  it("converts PascalCase String/Long/Boolean wrappers to raw values", () => {
    const result = normalizeEntities(PASCAL_CASE_ENTITIES, "avp");
    const attrs = result[0]!.attrs as Record<string, unknown>;
    expect(attrs["name"]).toBe("Alice");
    expect(attrs["age"]).toBe(30);
    expect(attrs["active"]).toBe(true);
  });

  it("converts PascalCase Parents EntityType/EntityId → type/id", () => {
    const result = normalizeEntities(PASCAL_CASE_ENTITIES, "avp");
    expect(result[0]!.parents[0]).toEqual({ type: "DocMgmt::Role", id: "admin" });
  });
});

describe("normalizePrincipalRef — camelCase and PascalCase", () => {
  it("handles camelCase entityType/entityId", () => {
    expect(normalizePrincipalRef({ entityType: "DocMgmt::User", entityId: "alice" }))
      .toEqual({ type: "DocMgmt::User", id: "alice" });
  });

  it("handles camelCase actionType/actionId", () => {
    expect(normalizePrincipalRef({ actionType: "DocMgmt::Action", actionId: "READ" }))
      .toEqual({ type: "DocMgmt::Action", id: "READ" });
  });

  it("handles PascalCase EntityType/EntityId", () => {
    expect(normalizePrincipalRef({ EntityType: "DocMgmt::User", EntityId: "alice" }))
      .toEqual({ type: "DocMgmt::User", id: "alice" });
  });

  it("handles PascalCase ActionType/ActionId", () => {
    expect(normalizePrincipalRef({ ActionType: "DocMgmt::Action", ActionId: "READ" }))
      .toEqual({ type: "DocMgmt::Action", id: "READ" });
  });
});

describe("unwrapAvpAttributes — entityIdentifier", () => {
  it("converts camelCase entityIdentifier to WASM __entity", () => {
    const result = unwrapAvpAttributes({
      owner: { entityIdentifier: { entityType: "SaaS::User", entityId: "alice" } },
    });
    expect(result["owner"]).toEqual({ __entity: { type: "SaaS::User", id: "alice" } });
  });

  it("converts PascalCase EntityIdentifier to WASM __entity", () => {
    const result = unwrapAvpAttributes({
      owner: { EntityIdentifier: { EntityType: "SaaS::User", EntityId: "alice" } },
    });
    expect(result["owner"]).toEqual({ __entity: { type: "SaaS::User", id: "alice" } });
  });

  it("converts snake_case entity_identifier to WASM __entity", () => {
    const result = unwrapAvpAttributes({
      owner: { entity_identifier: { entity_type: "SaaS::User", entity_id: "alice" } },
    });
    expect(result["owner"]).toEqual({ __entity: { type: "SaaS::User", id: "alice" } });
  });
});

describe("unwrapAvpAttributes — set and record types", () => {
  it("unwraps set with nested typed values", () => {
    const result = unwrapAvpAttributes({
      tags: { set: [{ string: "admin" }, { string: "ops" }] },
    });
    expect(result["tags"]).toEqual(["admin", "ops"]);
  });

  it("unwraps PascalCase Set", () => {
    const result = unwrapAvpAttributes({
      tags: { Set: [{ String: "admin" }, { String: "ops" }] },
    });
    expect(result["tags"]).toEqual(["admin", "ops"]);
  });

  it("unwraps record with nested typed values", () => {
    const result = unwrapAvpAttributes({
      config: { record: { theme: { string: "dark" }, lang: { string: "en" } } },
    });
    expect(result["config"]).toEqual({ theme: "dark", lang: "en" });
  });

  it("unwraps PascalCase Record", () => {
    const result = unwrapAvpAttributes({
      config: { Record: { theme: { String: "dark" } } },
    });
    expect(result["config"]).toEqual({ theme: "dark" });
  });
});

describe("unwrapAvpAttributes — Cedar 4 extension types", () => {
  it("converts ipaddr to WASM __extn format", () => {
    const result = unwrapAvpAttributes({ ip: { ipaddr: "192.168.1.1" } });
    expect(result["ip"]).toEqual({ __extn: { fn: "ip", arg: "192.168.1.1" } });
  });

  it("converts decimal to WASM __extn format", () => {
    const result = unwrapAvpAttributes({ price: { decimal: "1.50" } });
    expect(result["price"]).toEqual({ __extn: { fn: "decimal", arg: "1.50" } });
  });

  it("converts datetime to WASM __extn format", () => {
    const result = unwrapAvpAttributes({ at: { datetime: "2024-10-15T11:35:00Z" } });
    expect(result["at"]).toEqual({ __extn: { fn: "datetime", arg: "2024-10-15T11:35:00Z" } });
  });

  it("converts duration to WASM __extn format", () => {
    const result = unwrapAvpAttributes({ ttl: { duration: "1h30m" } });
    expect(result["ttl"]).toEqual({ __extn: { fn: "duration", arg: "1h30m" } });
  });
});
