import { isAuthorized, policySetTextToParts, policyToJson } from "@cedar-policy/cedar-wasm/nodejs";
import type {
  AuthorizationCall,
  CedarValueJson,
  Entities,
  Policy,
  PolicyId,
  Schema,
} from "@cedar-policy/cedar-wasm/nodejs";
import {
  detectFormat,
  normalizeEntities,
  normalizePrincipalRef,
} from "../utils/format-detector.js";
import type { FormatDetectionResult } from "../utils/format-detector.js";
import { storeManager } from "../resources/store-manager.js";

export interface AuthorizeInput {
  /** Concatenated Cedar policy text. Mutually exclusive with policiesMap. */
  policies?: string;
  /**
   * Map of policy id -> policy text. Each key becomes the WASM policy_id and
   * surfaces in determining_policies (overridden by an `@id` annotation when
   * present). Use this when the caller knows the source filename per policy.
   */
  policiesMap?: Record<string, string>;
  principal: string | Record<string, unknown>;
  action: string | Record<string, unknown>;
  resource: string | Record<string, unknown>;
  entities: string;
  schema?: string;
  context?: string;
  /**
   * Optional store name to disambiguate workspace auto-discovery (10d) at the
   * MCP layer. handleAuthorize itself does not consult the StoreManager; the
   * server.ts handler resolves this and supplies inputs before calling in.
   */
  store?: string;
}

export type AuthorizeDecisionReason =
  | "permit_policy_fired"
  | "forbid_policy_fired"
  | "default_deny_no_permit_matched"
  | "evaluation_error";

export interface AuthorizeResult {
  decision: "Allow" | "Deny";
  determining_policies: string[];
  errors: string[];
  decision_reason?: AuthorizeDecisionReason;
  format_detected?: string;
  format_note?: string;
  error?: string;
  /**
   * 10d workspace auto-discovery: populated by the server.ts MCP handler when
   * one or more inputs were resolved from a loaded MCP root rather than from
   * inline params. Each subfield names the store that satisfied the missing
   * input. Surfaces so the caller can trace which store the decision used.
   */
  auto_discovered?: {
    policies_from?: string;
    schema_from?: string;
    entities_from?: string;
  };
}

const DENY_RESULT = (error: string, detection?: FormatDetectionResult): AuthorizeResult => ({
  decision: "Deny",
  determining_policies: [],
  errors: [],
  ...(detection ? { format_detected: detection.format, format_note: detection.note } : {}),
  error,
});

/**
 * Extract the @id annotation from a single Cedar policy text, if present.
 * Returns undefined when the policy fails to parse OR when no @id is set.
 */
function readIdAnnotation(policyText: string): string | undefined {
  const parsed = policyToJson(policyText);
  if (parsed.type !== "success") return undefined;
  const id = parsed.json.annotations?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Build a Record<policyId, Policy> from caller input.
 *
 * Resolution order for each policy's id:
 *   1. The @id("name") annotation on the policy (highest priority)
 *   2. The caller-provided basename (key in policiesMap)
 *   3. positional "policy<index>" fallback
 *
 * For a flat policies string, we split it via policySetTextToParts so each
 * policy gets its own id rather than collapsing into a single anonymous blob.
 *
 * Exported so cedar_authorize_batch can apply the same H1 resolution and
 * surface the same stable IDs as the single-request handler (kickoff-14 14a).
 */
export function buildStaticPolicies(
  input: Pick<AuthorizeInput, "policies" | "policiesMap">
): { record: Record<PolicyId, Policy> } | { error: string } {
  const record: Record<PolicyId, Policy> = {};
  const usedIds = new Set<string>();

  const assignId = (preferredId: string, fallbackBase: string): string => {
    let id = preferredId;
    if (usedIds.has(id)) {
      // Disambiguate duplicates so the WASM call does not collide.
      let suffix = 2;
      while (usedIds.has(`${fallbackBase}-${suffix}`)) suffix++;
      id = `${fallbackBase}-${suffix}`;
    }
    usedIds.add(id);
    return id;
  };

  if (input.policiesMap) {
    for (const [basename, text] of Object.entries(input.policiesMap)) {
      const annotation = readIdAnnotation(text);
      const preferred = annotation ?? basename;
      const id = assignId(preferred, basename);
      record[id] = text;
    }
    return { record };
  }

  const text = input.policies ?? "";
  const parts = policySetTextToParts(text);
  if (parts.type === "failure") {
    // Fall through with a single positional entry; downstream isAuthorized
    // will surface the parse error in the standard errors[] channel.
    record["policy0"] = text;
    return { record };
  }

  parts.policies.forEach((policyText: string, idx: number) => {
    const annotation = readIdAnnotation(policyText);
    const fallback = `policy${idx}`;
    const preferred = annotation ?? fallback;
    const id = assignId(preferred, fallback);
    record[id] = policyText;
  });

  return { record };
}

/**
 * Classify the authorization outcome into one of four reason codes.
 * See AuthorizeDecisionReason for the contract.
 */
function classifyDecisionReason(
  decision: "Allow" | "Deny",
  determining: string[],
  errors: string[],
  staticPolicies: Record<PolicyId, Policy>
): AuthorizeDecisionReason {
  if (errors.length > 0) return "evaluation_error";
  if (decision === "Allow") return "permit_policy_fired";
  // Deny path.
  if (determining.length === 0) return "default_deny_no_permit_matched";
  // At least one determining policy fired on a Deny -> a forbid policy.
  // Verify defensively by checking the policy's effect; if any determining
  // entry parses as forbid, classify as forbid_policy_fired.
  for (const id of determining) {
    const text = staticPolicies[id];
    if (typeof text !== "string") continue;
    const parsed = policyToJson(text);
    if (parsed.type === "success" && parsed.json.effect === "forbid") {
      return "forbid_policy_fired";
    }
  }
  // Fallback: a determining policy exists on Deny but is not a parseable forbid.
  return "forbid_policy_fired";
}

export async function handleAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
  // Parse entities first so we can run format detection.
  // Also unwrap the AVP SDK entity_list/entityList envelope:
  //   Ruby SDK:    { entity_list: [...] }
  //   Python/JS:   { entityList: [...] }
  //   Official API: { entityList: [...] }
  // Users sometimes copy the full SDK entities parameter value rather than just the array.
  let rawEntities: unknown[];
  try {
    const parsed = JSON.parse(input.entities as string);
    if (Array.isArray(parsed)) {
      rawEntities = parsed;
    } else if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const list = obj["entity_list"] ?? obj["entityList"] ?? obj["EntityList"];
      if (Array.isArray(list)) {
        rawEntities = list;
      } else {
        throw new Error("not an array");
      }
    } else {
      throw new Error("not an array");
    }
  } catch {
    return DENY_RESULT("entities must be a valid JSON array or an AVP entity_list object");
  }

  // Detect format across all inputs together
  const detection = detectFormat(rawEntities, input.principal, input.action, input.resource);

  // Normalize entities and principal/action/resource to WASM format
  const normalizedEntities = normalizeEntities(rawEntities, detection.format);

  const principalRef = normalizePrincipalRef(input.principal);
  if ("error" in principalRef) return DENY_RESULT(principalRef.error, detection);

  const actionRef = normalizePrincipalRef(input.action);
  if ("error" in actionRef) return DENY_RESULT(actionRef.error, detection);

  const resourceRef = normalizePrincipalRef(input.resource);
  if ("error" in resourceRef) return DENY_RESULT(resourceRef.error, detection);

  if (!input.policies && !input.policiesMap) {
    return DENY_RESULT("policies or policiesMap is required", detection);
  }

  const built = buildStaticPolicies(input);
  if ("error" in built) return DENY_RESULT(built.error, detection);
  const staticPolicies = built.record;

  let schema: Schema | undefined;
  if (input.schema) {
    try {
      schema = JSON.parse(input.schema as string);
    } catch {
      schema = input.schema as string;
    }
  }

  let context: Record<string, CedarValueJson> = {};
  if (input.context) {
    try {
      context = JSON.parse(input.context);
    } catch {
      return DENY_RESULT("context must be a valid JSON object", detection);
    }
  }

  const call: AuthorizationCall = {
    principal: principalRef,
    action: actionRef,
    resource: resourceRef,
    context,
    policies: { staticPolicies },
    entities: normalizedEntities as Entities,
    ...(schema ? { schema, validateRequest: true } : {}),
  };

  // per spike-report-wasm-api.md §1: type field is "success"|"failure" for WASM health,
  // decision is "allow"|"deny" for the authorization result
  const answer = isAuthorized(call);

  if (answer.type === "failure") {
    const errorMessages = answer.errors.map((e) => e.message);
    return {
      decision: "Deny",
      determining_policies: [],
      errors: errorMessages,
      decision_reason: "evaluation_error",
      format_detected: detection.format,
      format_note: detection.note,
    };
  }

  const { decision, diagnostics } = answer.response;
  const normalizedDecision: "Allow" | "Deny" = decision === "allow" ? "Allow" : "Deny";
  const determining = diagnostics.reason;
  const errorMessages = diagnostics.errors.map((e) => e.error.message);

  return {
    decision: normalizedDecision,
    determining_policies: determining,
    errors: errorMessages,
    decision_reason: classifyDecisionReason(normalizedDecision, determining, errorMessages, staticPolicies),
    format_detected: detection.format,
    format_note: detection.note,
  };
}

// ─── 10d workspace auto-discovery wrapper ────────────────────────────────────

/**
 * Inputs accepted by the MCP-level authorize entry point. Wider than
 * `AuthorizeInput` because it also accepts the `_ref` shapes the MCP layer
 * resolves before reaching `handleAuthorize`. Kept distinct so the WASM-level
 * handler does not need to know about MCP plumbing.
 */
export interface AuthorizeMcpInput {
  policies?: string;
  policy_ref?: string;
  policiesMap?: Record<string, string>;
  principal: string | Record<string, unknown>;
  action: string | Record<string, unknown>;
  resource: string | Record<string, unknown>;
  entities?: string;
  entities_ref?: string;
  schema?: string;
  schema_ref?: string;
  context?: string;
  store?: string;
}

/**
 * 10d workspace auto-discovery wrapper for `cedar_authorize`.
 *
 * Resolves missing policies / schema / entities from the loaded MCP roots,
 * then delegates to `handleAuthorize`. A single store backs all three so a
 * call never mixes policies from one workspace with entities from another.
 *
 * Multi-store deployments with no explicit `store` parameter surface an
 * ambiguity error in the `{ error }` envelope. None-loaded falls through to
 * the "policies / entities required" errors that the MCP layer already used.
 *
 * Returns either:
 *  - `{ result }` -- the AuthorizeResult, with `auto_discovered` set when any
 *    input was sourced from the workspace.
 *  - `{ error }`  -- a string error suitable for the standard `{ error: ... }`
 *    MCP envelope.
 *
 * The server.ts handler wraps this and serializes the result back to MCP.
 * Tests can call it directly after setting up the `storeManager` singleton
 * with `loadFromRoots([...])`.
 */
export async function handleAuthorizeMcp(
  input: AuthorizeMcpInput,
  resolveRef: (uri: string) => { content: string } | { error: string },
): Promise<{ result: AuthorizeResult } | { error: string }> {
  const needsAuto =
    (!input.policies && !input.policy_ref && !input.policiesMap) ||
    (!input.schema && !input.schema_ref) ||
    (!input.entities && !input.entities_ref);

  let autoStore: string | undefined;
  if (needsAuto) {
    if (input.store) {
      if (!storeManager.getStore(input.store)) {
        const available = storeManager.listStoreNames().join(", ") || "none";
        return { error: `Store not found: "${input.store}". Available stores: ${available}.` };
      }
      autoStore = input.store;
    } else {
      const def = storeManager.getDefaultStore();
      if (def.kind === "single") autoStore = def.store.name;
      else if (def.kind === "ambiguous") {
        return { error: `Multiple stores are loaded (${def.names.join(", ")}). Pass store: "<name>" to choose.` };
      }
      // def.kind === "none": leave autoStore undefined and let the
      // "Either X or X_ref is required" branches below fire.
    }
  }

  // Resolve policy_ref / policies. The cedar://policies/{store} loop pattern
  // keeps each policy's basename as its determining-policies id rather than
  // collapsing the set into a single blob.
  let policies = input.policies;
  let policiesMap = input.policiesMap;
  let policiesFrom: string | undefined;
  if (!policies && !policiesMap && input.policy_ref) {
    const storeMatch = input.policy_ref.match(/^cedar:\/\/policies\/([^/]+)$/);
    const singleMatch = input.policy_ref.match(/^cedar:\/\/policies\/([^/]+)\/([^/]+)$/);
    if (storeMatch) {
      const storeName = storeMatch[1]!;
      try {
        const ids = storeManager.listPolicies(storeName);
        policiesMap = {};
        for (const id of ids) policiesMap[id] = storeManager.readPolicy(storeName, id);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    } else if (singleMatch) {
      const storeName = singleMatch[1]!;
      const policyId = singleMatch[2]!;
      try {
        policiesMap = { [policyId]: storeManager.readPolicy(storeName, policyId) };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      const resolved = resolveRef(input.policy_ref);
      if ("error" in resolved) return { error: resolved.error };
      policies = resolved.content;
    }
  }
  if (!policies && !policiesMap && autoStore) {
    try {
      const ids = storeManager.listPolicies(autoStore);
      policiesMap = {};
      for (const id of ids) policiesMap[id] = storeManager.readPolicy(autoStore, id);
      policiesFrom = autoStore;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (!policies && !policiesMap) return { error: "Either policies or policy_ref is required" };

  let schema = input.schema;
  let schemaFrom: string | undefined;
  if (!schema && input.schema_ref) {
    const resolved = resolveRef(input.schema_ref);
    if ("error" in resolved) return { error: resolved.error };
    schema = resolved.content;
  }
  if (!schema && autoStore) {
    try {
      schema = storeManager.readSchema(autoStore);
      schemaFrom = autoStore;
    } catch {
      // Store has no schema file; schema stays undefined (it is optional).
    }
  }

  let entities = input.entities;
  let entitiesFrom: string | undefined;
  if (!entities && input.entities_ref) {
    const resolved = resolveRef(input.entities_ref);
    if ("error" in resolved) return { error: resolved.error };
    entities = resolved.content;
  }
  if (!entities && autoStore) {
    // Only claim entities_from if the store actually has an entities/
    // subdirectory with files. readAllEntities returns "[]" when the
    // directory is missing, which would otherwise have us lie in
    // auto_discovered.entities_from about the source of zero entities.
    try {
      const entityFiles = storeManager.listEntities(autoStore);
      if (entityFiles.length > 0) {
        entities = storeManager.readAllEntities(autoStore);
        entitiesFrom = autoStore;
      } else {
        entities = "[]";
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (!entities) return { error: "Either entities or entities_ref is required" };

  const result = await handleAuthorize({
    policies,
    policiesMap,
    principal: input.principal,
    action: input.action,
    resource: input.resource,
    entities,
    schema,
    context: input.context,
  });

  const autoDiscovered: { policies_from?: string; schema_from?: string; entities_from?: string } = {};
  if (policiesFrom) autoDiscovered.policies_from = policiesFrom;
  if (schemaFrom) autoDiscovered.schema_from = schemaFrom;
  if (entitiesFrom) autoDiscovered.entities_from = entitiesFrom;
  if (Object.keys(autoDiscovered).length > 0) {
    result.auto_discovered = autoDiscovered;
  }
  return { result };
}
