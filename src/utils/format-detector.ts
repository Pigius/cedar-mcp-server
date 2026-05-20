/**
 * Cedar input format detection and normalization.
 *
 * Three AVP SDK variants exist in the wild — all need conversion to Cedar WASM format:
 *
 *   Ruby SDK (snake_case):   identifier.entity_type / entity_id, string/long/boolean
 *   Python/JS SDK (camelCase): identifier.entityType / entityId, string/long/boolean
 *   Official API/Console (PascalCase): Identifier.EntityType / EntityId, String/Long/Boolean
 *
 * Cedar WASM format:
 *   uid: { type, id }, attrs: { key: rawValue }, parents: [{ type, id }]
 *   Entity refs in attrs: { __entity: { type, id } }
 *   Extension types: { __extn: { fn, arg } }
 *
 * Detection strategy: case-insensitive key lookup handles all three casing variants
 * in a single code path. One normalizer to rule them all.
 *
 * Cedar CLI format (uid.__entity wrapper): WASM accepts natively — no conversion needed.
 *
 * Attribute value wrapper detection rule:
 *   Single-key object whose key (lowercased) is a known AVP type name AND whose value
 *   is the matching primitive. Multi-key objects are Cedar Records — not touched.
 *
 * Limitation: a Cedar Record with exactly one field named "string"/"long"/"boolean"
 *   would be misidentified. Adding a second field removes the ambiguity.
 *
 * Sources confirmed by SDK docs (2026-05-20):
 *   Ruby: entity_type/entity_id/entity_identifier (snake_case)
 *   Python/JS: entityType/entityId/entityIdentifier (camelCase)
 *   Official API: EntityType/EntityId/EntityIdentifier (PascalCase)
 */

export type InputFormat = "cedar" | "avp" | "cedar_cli";

export interface FormatDetectionResult {
  format: InputFormat;
  confidence: "high" | "medium";
  note: string;
}

export interface NormalizedRef {
  type: string;
  id: string;
}

export interface NormalizedRefError {
  error: string;
}

// ─── Case-insensitive key access ──────────────────────────────────────────────

/** Find the value of a key case-insensitively. First match wins. */
function getCI(obj: Record<string, unknown>, key: string): unknown {
  const lower = key.toLowerCase();
  const found = Object.keys(obj).find((k) => k.toLowerCase() === lower);
  return found !== undefined ? obj[found] : undefined;
}

function hasKeyCI(obj: Record<string, unknown>, key: string): boolean {
  const lower = key.toLowerCase();
  return Object.keys(obj).some((k) => k.toLowerCase() === lower);
}

// ─── Detection ────────────────────────────────────────────────────────────────

export function detectFormat(
  entities: unknown[],
  principal: unknown,
  action: unknown,
  resource: unknown
): FormatDetectionResult {
  // AVP principal/action/resource — any casing of entity_type/entityType/EntityType
  if (isAvpRef(principal) || isAvpActionRef(action) || isAvpRef(resource)) {
    return {
      format: "avp",
      confidence: "high",
      note: "Principal, action, or resource is in AVP format (entity_type/entityType/EntityType keys). Automatically converted to Cedar format.",
    };
  }

  // AVP entity list: `identifier` key (case-insensitive) is the clearest signal
  if (entities.some(hasAvpIdentifierKey)) {
    return {
      format: "avp",
      confidence: "high",
      note: "Entities are in AVP format (identifier/Identifier key, typed attribute wrappers). Automatically converted to Cedar format.",
    };
  }

  // AVP-typed attribute values without identifier key (partial AVP)
  if (entities.some(hasAvpTypedAttributeValues)) {
    return {
      format: "avp",
      confidence: "medium",
      note: "Entity attributes appear to use AVP typed wrappers (string/long/boolean/set/record). Automatically unwrapped to raw Cedar values.",
    };
  }

  // Cedar CLI uid.__entity wrapper — WASM accepts natively, no conversion needed
  if (entities.some(hasCedarCliEntityWrapper)) {
    return {
      format: "cedar_cli",
      confidence: "high",
      note: "Entity UIDs use the __entity wrapper (Cedar CLI format). Compatible with Cedar WASM — no conversion needed.",
    };
  }

  return {
    format: "cedar",
    confidence: "high",
    note: "Input is in Cedar/WASM format.",
  };
}

// ─── Normalization ────────────────────────────────────────────────────────────

export function normalizeEntities(entities: unknown[], format: InputFormat): unknown[] {
  if (format === "cedar" || format === "cedar_cli") return entities;
  return entities.map(normalizeAvpEntity);
}

export function normalizePrincipalRef(ref: unknown): NormalizedRef | NormalizedRefError {
  // Cedar string literal: 'Ns::Type::"id"'
  if (typeof ref === "string") {
    const match = ref.match(/^(.+)::"(.+)"$/);
    if (!match) return { error: `Invalid Cedar entity reference: "${ref}". Expected: Namespace::Type::"id"` };
    return { type: match[1]!, id: match[2]! };
  }

  if (typeof ref !== "object" || ref === null) {
    return { error: `Unrecognized entity reference format: ${JSON.stringify(ref)}` };
  }

  const obj = ref as Record<string, unknown>;

  // WASM native: { type, id }
  if (typeof obj["type"] === "string" && typeof obj["id"] === "string") {
    return { type: obj["type"], id: obj["id"] };
  }

  // WASM Cedar CLI: { __entity: { type, id } }
  if (obj["__entity"] && typeof obj["__entity"] === "object") {
    const inner = obj["__entity"] as Record<string, unknown>;
    if (typeof inner["type"] === "string" && typeof inner["id"] === "string") {
      return { type: inner["type"], id: inner["id"] };
    }
  }

  // AVP entity ref — all three casings (entity_type / entityType / EntityType)
  const entityType = getCI(obj, "entity_type") ?? getCI(obj, "entityType") ?? getCI(obj, "EntityType");
  const entityId = getCI(obj, "entity_id") ?? getCI(obj, "entityId") ?? getCI(obj, "EntityId");
  if (typeof entityType === "string" && typeof entityId === "string") {
    return { type: entityType, id: entityId };
  }

  // AVP action ref — all three casings (action_type / actionType / ActionType)
  const actionType = getCI(obj, "action_type") ?? getCI(obj, "actionType") ?? getCI(obj, "ActionType");
  const actionId = getCI(obj, "action_id") ?? getCI(obj, "actionId") ?? getCI(obj, "ActionId");
  if (typeof actionType === "string" && typeof actionId === "string") {
    return { type: actionType, id: actionId };
  }

  return { error: `Unrecognized entity reference format: ${JSON.stringify(ref)}` };
}

export function unwrapAvpAttributes(
  attrs: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    result[key] = unwrapAvpValue(value);
  }
  return result;
}

// ─── Private: detection helpers ───────────────────────────────────────────────

function isAvpRef(ref: unknown): boolean {
  if (typeof ref !== "object" || ref === null) return false;
  const obj = ref as Record<string, unknown>;
  const hasType =
    typeof getCI(obj, "entity_type") === "string" ||
    typeof getCI(obj, "entityType") === "string" ||
    typeof getCI(obj, "EntityType") === "string";
  const hasId =
    typeof getCI(obj, "entity_id") === "string" ||
    typeof getCI(obj, "entityId") === "string" ||
    typeof getCI(obj, "EntityId") === "string";
  return hasType && hasId;
}

function isAvpActionRef(ref: unknown): boolean {
  if (typeof ref !== "object" || ref === null) return false;
  const obj = ref as Record<string, unknown>;
  const hasType =
    typeof getCI(obj, "action_type") === "string" ||
    typeof getCI(obj, "actionType") === "string" ||
    typeof getCI(obj, "ActionType") === "string";
  const hasId =
    typeof getCI(obj, "action_id") === "string" ||
    typeof getCI(obj, "actionId") === "string" ||
    typeof getCI(obj, "ActionId") === "string";
  return hasType && hasId;
}

function hasAvpIdentifierKey(entity: unknown): boolean {
  if (typeof entity !== "object" || entity === null) return false;
  return hasKeyCI(entity as Record<string, unknown>, "identifier");
}

function hasAvpTypedAttributeValues(entity: unknown): boolean {
  if (typeof entity !== "object" || entity === null) return false;
  const e = entity as Record<string, unknown>;
  const rawAttrs =
    getCI(e, "attributes") ??
    getCI(e, "Attributes") ??
    e["attrs"];
  if (!rawAttrs || typeof rawAttrs !== "object") return false;
  return Object.values(rawAttrs as Record<string, unknown>).some(isAvpTypedValue);
}

function hasCedarCliEntityWrapper(entity: unknown): boolean {
  if (typeof entity !== "object" || entity === null) return false;
  const e = entity as Record<string, unknown>;
  const uid = e["uid"];
  if (typeof uid !== "object" || uid === null) return false;
  return "__entity" in (uid as Record<string, unknown>);
}

/**
 * Detects AVP typed value wrappers (case-insensitive type key).
 * Rule: single-key object whose key lowercased is a known AVP type name with matching value type.
 * Multi-key objects are Cedar Records.
 */
function isAvpTypedValue(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  if (keys.length !== 1) return false;
  const key = keys[0]!.toLowerCase();
  const val = (v as Record<string, unknown>)[keys[0]!];
  return (
    (key === "string" && typeof val === "string") ||
    (key === "long" && typeof val === "number") ||
    (key === "boolean" && typeof val === "boolean") ||
    key === "entityidentifier" ||
    key === "entity_identifier" ||
    key === "set" ||
    key === "record" ||
    key === "ipaddr" ||
    key === "ipaddress" ||
    key === "decimal" ||
    key === "datetime" ||
    key === "duration"
  );
}

// ─── Private: value unwrapping ────────────────────────────────────────────────

function unwrapAvpValue(v: unknown): unknown {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return v;

  const keys = Object.keys(v as object);
  if (keys.length !== 1) return v; // Multi-key object = Cedar Record, not AVP wrapper

  const key = keys[0]!;
  const lowerKey = key.toLowerCase();
  const val = (v as Record<string, unknown>)[key];

  switch (lowerKey) {
    case "string":
      return typeof val === "string" ? val : v;
    case "long":
      return typeof val === "number" ? val : v;
    case "boolean":
      return typeof val === "boolean" ? val : v;

    // Entity reference → WASM __entity
    case "entityidentifier":
    case "entity_identifier": {
      const ref = resolveAvpEntityRef(val);
      return ref ? { __entity: ref } : v;
    }

    // Set → array (recursively normalize values)
    case "set":
      return Array.isArray(val) ? val.map(unwrapAvpValue) : v;

    // Record → object (recursively normalize values)
    case "record":
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        return unwrapAvpAttributes(val as Record<string, unknown>);
      }
      return v;

    // Cedar extension types → WASM __extn format
    case "ipaddr":
    case "ipaddress":
      return typeof val === "string" ? { __extn: { fn: "ip", arg: val } } : v;
    case "decimal":
      return typeof val === "string" ? { __extn: { fn: "decimal", arg: val } } : v;
    case "datetime":
      return typeof val === "string" ? { __extn: { fn: "datetime", arg: val } } : v;
    case "duration":
      return typeof val === "string" ? { __extn: { fn: "duration", arg: val } } : v;

    default:
      return v;
  }
}

/** Resolves an AVP entity reference object (any casing) to { type, id }. */
function resolveAvpEntityRef(ref: unknown): { type: string; id: string } | null {
  if (typeof ref !== "object" || ref === null) return null;
  const obj = ref as Record<string, unknown>;
  const type =
    (getCI(obj, "entity_type") ?? getCI(obj, "entityType") ?? getCI(obj, "EntityType")) as string | undefined;
  const id =
    (getCI(obj, "entity_id") ?? getCI(obj, "entityId") ?? getCI(obj, "EntityId")) as string | undefined;
  if (type && id) return { type, id };
  return null;
}

// ─── Private: entity normalization ───────────────────────────────────────────

function normalizeAvpEntity(entity: unknown): unknown {
  if (typeof entity !== "object" || entity === null) return entity;
  const e = entity as Record<string, unknown>;

  // UID: find identifier/Identifier key (any casing), convert to { type, id }
  const identifierKey = Object.keys(e).find((k) => k.toLowerCase() === "identifier");
  let uid: unknown;
  if (identifierKey) {
    const idObj = e[identifierKey] as Record<string, unknown>;
    const type = getCI(idObj, "entity_type") ?? getCI(idObj, "entityType") ?? getCI(idObj, "EntityType");
    const id = getCI(idObj, "entity_id") ?? getCI(idObj, "entityId") ?? getCI(idObj, "EntityId");
    uid = { type, id };
  } else {
    uid = e["uid"];
  }

  // Attrs: find attributes/Attributes key (any casing), fall back to attrs
  const attrsKey = Object.keys(e).find((k) => k.toLowerCase() === "attributes");
  const rawAttrs = (attrsKey ? e[attrsKey] : e["attrs"]) ?? {};
  const attrs = unwrapAvpAttributes(rawAttrs as Record<string, unknown>);

  // Parents: find parents/Parents key (any casing), convert entity_type/entityType/EntityType → type/id
  const parentsKey = Object.keys(e).find((k) => k.toLowerCase() === "parents");
  const rawParents = ((parentsKey ? e[parentsKey] : e["parents"]) ?? []) as unknown[];
  const parents = rawParents.map((p) => {
    if (typeof p !== "object" || p === null) return p;
    const ref = resolveAvpEntityRef(p);
    return ref ?? p;
  });

  return { uid, attrs, parents };
}
