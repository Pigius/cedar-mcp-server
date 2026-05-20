/**
 * Cedar input format detection and normalization.
 *
 * Three formats exist in the wild, with different levels of WASM compatibility:
 *
 * "cedar"     — WASM native format. uid: { type, id }, raw attribute values,
 *               Cedar string literals for principal/action/resource.
 *               → Pass through unchanged.
 *
 * "cedar_cli" — Cedar CLI entity file format. uid: { __entity: { type, id } }.
 *               WASM accepts the __entity wrapper natively (proven by spike 2026-05-20),
 *               so no conversion is required.
 *               → Pass through unchanged. Noted in response for user awareness.
 *
 * "avp"       — AWS Verified Permissions SDK payload format.
 *               - Entity UID key: `identifier: { entity_type, entity_id }` (not `uid`)
 *               - Entity attrs key: `attributes` (not `attrs`)
 *               - Attribute values: typed wrappers `{ string: "v" }`, `{ long: 42 }`, `{ boolean: true }`
 *               - Parent refs: `{ entity_type, entity_id }` (not `{ type, id }`)
 *               - Principal/action/resource: structured objects `{ entity_type, entity_id }`
 *               WASM REJECTS avp format entirely (hard parse errors, proven by spike).
 *               → Must be converted to cedar format before passing to WASM.
 *
 * Limitation: AVP attribute wrapping detection uses the heuristic:
 *   "a single-key object whose key is `string`, `long`, or `boolean` with a matching primitive value"
 *   A Cedar Record attribute with exactly one field named `string`/`long`/`boolean` would be
 *   misidentified. Adding a second field to such a Record removes the ambiguity.
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

// ─── Detection ───────────────────────────────────────────────────────────────

export function detectFormat(
  entities: unknown[],
  principal: unknown,
  action: unknown,
  resource: unknown
): FormatDetectionResult {
  // AVP principal/action/resource objects are a definitive signal
  if (isAvpRef(principal) || isAvpActionRef(action) || isAvpRef(resource)) {
    return {
      format: "avp",
      confidence: "high",
      note: "Principal, action, or resource is in AVP format ({ entity_type, entity_id }). Automatically converted to Cedar format.",
    };
  }

  // AVP entity structure: `identifier` key is the clearest signal
  if (entities.some(hasAvpIdentifierKey)) {
    return {
      format: "avp",
      confidence: "high",
      note: "Entities are in AVP format (identifier key, entity_type/entity_id, typed attribute values). Automatically converted to Cedar format.",
    };
  }

  // AVP attribute wrapping without identifier key (partial AVP — unusual but possible)
  if (entities.some(hasAvpTypedAttributes)) {
    return {
      format: "avp",
      confidence: "medium",
      note: "Entity attributes appear to use AVP typed wrappers ({ string, long, boolean }). Automatically unwrapped to raw Cedar values.",
    };
  }

  // Cedar CLI uid.__entity wrapper — WASM handles this natively, no conversion needed
  if (entities.some(hasCedarCliEntityWrapper)) {
    return {
      format: "cedar_cli",
      confidence: "high",
      note: "Entity UIDs use the __entity wrapper (Cedar CLI format). This is compatible with Cedar WASM — no conversion needed.",
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
    if (!match) return { error: `Invalid Cedar entity reference: "${ref}". Expected format: Namespace::Type::"id"` };
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

  // WASM native (Cedar CLI wrapper): { __entity: { type, id } }
  if (obj["__entity"] && typeof obj["__entity"] === "object") {
    const inner = obj["__entity"] as Record<string, unknown>;
    if (typeof inner["type"] === "string" && typeof inner["id"] === "string") {
      return { type: inner["type"], id: inner["id"] };
    }
  }

  // AVP entity ref: { entity_type, entity_id }
  if (typeof obj["entity_type"] === "string" && typeof obj["entity_id"] === "string") {
    return { type: obj["entity_type"], id: obj["entity_id"] };
  }

  // AVP action ref: { action_type, action_id }
  if (typeof obj["action_type"] === "string" && typeof obj["action_id"] === "string") {
    return { type: obj["action_type"], id: obj["action_id"] };
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

// ─── Private helpers ──────────────────────────────────────────────────────────

function isAvpRef(ref: unknown): boolean {
  if (typeof ref !== "object" || ref === null) return false;
  const obj = ref as Record<string, unknown>;
  return typeof obj["entity_type"] === "string" && typeof obj["entity_id"] === "string";
}

function isAvpActionRef(ref: unknown): boolean {
  if (typeof ref !== "object" || ref === null) return false;
  const obj = ref as Record<string, unknown>;
  return typeof obj["action_type"] === "string" && typeof obj["action_id"] === "string";
}

function hasAvpIdentifierKey(entity: unknown): boolean {
  if (typeof entity !== "object" || entity === null) return false;
  return "identifier" in (entity as Record<string, unknown>);
}

function hasAvpTypedAttributes(entity: unknown): boolean {
  if (typeof entity !== "object" || entity === null) return false;
  const e = entity as Record<string, unknown>;
  // Check both "attributes" key (AVP) and "attrs" key (WASM with typed values)
  const attrs = (e["attributes"] ?? e["attrs"]) as Record<string, unknown> | undefined;
  if (!attrs || typeof attrs !== "object") return false;
  return Object.values(attrs).some(isAvpTypedValue);
}

function hasCedarCliEntityWrapper(entity: unknown): boolean {
  if (typeof entity !== "object" || entity === null) return false;
  const e = entity as Record<string, unknown>;
  if (typeof e["uid"] !== "object" || e["uid"] === null) return false;
  return "__entity" in (e["uid"] as Record<string, unknown>);
}

/**
 * Detects AVP typed value wrappers.
 * Rule: a single-key object where the key is "string", "long", or "boolean"
 * AND the value is the matching primitive type.
 * Multi-key objects are Cedar Records, not AVP wrappers.
 */
function isAvpTypedValue(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  if (keys.length !== 1) return false;
  const key = keys[0]!;
  const val = (v as Record<string, unknown>)[key];
  return (
    (key === "string" && typeof val === "string") ||
    (key === "long" && typeof val === "number") ||
    (key === "boolean" && typeof val === "boolean")
  );
}

function unwrapAvpValue(v: unknown): unknown {
  if (!isAvpTypedValue(v)) return v;
  const obj = v as Record<string, unknown>;
  return obj["string"] ?? obj["long"] ?? obj["boolean"];
}

function normalizeAvpEntity(entity: unknown): unknown {
  if (typeof entity !== "object" || entity === null) return entity;
  const e = entity as Record<string, unknown>;

  // UID: convert identifier → uid with { type, id }
  let uid: unknown;
  if (e["identifier"] && typeof e["identifier"] === "object") {
    const id = e["identifier"] as Record<string, unknown>;
    uid = { type: id["entity_type"], id: id["entity_id"] };
  } else {
    uid = e["uid"];
  }

  // Attrs: convert attributes → attrs, unwrap typed values
  const rawAttrs = (e["attributes"] ?? e["attrs"] ?? {}) as Record<string, unknown>;
  const attrs = unwrapAvpAttributes(rawAttrs);

  // Parents: convert entity_type/entity_id → type/id
  const rawParents = (e["parents"] ?? []) as unknown[];
  const parents = rawParents.map((p) => {
    if (typeof p !== "object" || p === null) return p;
    const parent = p as Record<string, unknown>;
    if (typeof parent["entity_type"] === "string" && typeof parent["entity_id"] === "string") {
      return { type: parent["entity_type"], id: parent["entity_id"] };
    }
    return p;
  });

  return { uid, attrs, parents };
}
