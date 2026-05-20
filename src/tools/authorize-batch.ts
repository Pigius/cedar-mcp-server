import { isAuthorized } from "@cedar-policy/cedar-wasm/nodejs";
import type { AuthorizationCall, CedarValueJson, Entities, Schema } from "@cedar-policy/cedar-wasm/nodejs";
import {
  detectFormat,
  normalizeEntities,
  normalizePrincipalRef,
} from "../utils/format-detector.js";
import { resolveRef } from "../resources/ref-resolver.js";

export interface AuthorizeBatchInput {
  policies?: string;       // inline Cedar policies
  policy_ref?: string;     // cedar:// URI resolving to policies
  schema?: string;         // inline JSON schema
  schema_ref?: string;     // cedar:// URI resolving to schema
  requests: string;        // JSON array of authorization request objects
  entities?: string;       // shared entities applied when individual request omits its own
}

export interface BatchDecision {
  index: number;
  principal: string;
  action: string;
  resource: string;
  decision: "Allow" | "Deny" | "Error";
  determining_policies?: string[];
  error?: string;
}

export interface AuthorizeBatchResult {
  total: number;
  allowed: number;
  denied: number;
  errored: number;
  decisions: BatchDecision[];
  summary: string;
}

// ─── Raw request shape inside the `requests` JSON array ───────────────────────

interface RawRequest {
  principal: unknown;
  action: unknown;
  resource: unknown;
  entities?: unknown;
  context?: unknown;
  schema?: unknown;
}

// ─── Main handler ──────────────────────────────────────────────────────────────

export async function handleAuthorizeBatch(
  input: AuthorizeBatchInput
): Promise<AuthorizeBatchResult> {
  // 1. Resolve policies
  let policiesText: string;
  if (input.policies) {
    policiesText = input.policies;
  } else if (input.policy_ref) {
    const resolved = resolveRef(input.policy_ref);
    if ("error" in resolved) {
      return zeroResult(`Failed to resolve policy_ref: ${resolved.error}`);
    }
    policiesText = resolved.content;
  } else {
    return zeroResult("Either policies or policy_ref is required.");
  }

  // 2. Resolve schema (optional)
  let schema: Schema | undefined;
  if (input.schema_ref) {
    const resolved = resolveRef(input.schema_ref);
    if ("error" in resolved) {
      return zeroResult(`Failed to resolve schema_ref: ${resolved.error}`);
    }
    schema = parseSchema(resolved.content);
  } else if (input.schema) {
    schema = parseSchema(input.schema);
  }

  // 3. Parse the shared entities (optional baseline; individual requests may override)
  let sharedEntitiesArray: unknown[] | null = null;
  if (input.entities) {
    const parsed = parseEntitiesString(input.entities);
    if (parsed === null) {
      return zeroResult(
        "shared entities must be a valid JSON array or AVP entity_list object"
      );
    }
    sharedEntitiesArray = parsed;
  }

  // 4. Parse the requests array
  let rawRequests: RawRequest[];
  try {
    const parsed = JSON.parse(input.requests);
    if (!Array.isArray(parsed)) {
      return zeroResult("requests must be a JSON array");
    }
    rawRequests = parsed as RawRequest[];
  } catch {
    return zeroResult("requests is not valid JSON");
  }

  if (rawRequests.length === 0) {
    return {
      total: 0,
      allowed: 0,
      denied: 0,
      errored: 0,
      decisions: [],
      summary: "0 requests: no requests to evaluate.",
    };
  }

  // 5. Evaluate each request individually
  const decisions: BatchDecision[] = [];
  let allowed = 0;
  let denied = 0;
  let errored = 0;

  for (let i = 0; i < rawRequests.length; i++) {
    const req = rawRequests[i]!;

    const principalStr = refToString(req.principal);
    const actionStr = refToString(req.action);
    const resourceStr = refToString(req.resource);

    // 5a. Normalize principal / action / resource refs
    const principalRef = normalizePrincipalRef(req.principal);
    if ("error" in principalRef) {
      decisions.push(errorDecision(i, principalStr, actionStr, resourceStr, principalRef.error));
      errored++;
      continue;
    }

    const actionRef = normalizePrincipalRef(req.action);
    if ("error" in actionRef) {
      decisions.push(errorDecision(i, principalStr, actionStr, resourceStr, actionRef.error));
      errored++;
      continue;
    }

    const resourceRef = normalizePrincipalRef(req.resource);
    if ("error" in resourceRef) {
      decisions.push(errorDecision(i, principalStr, actionStr, resourceStr, resourceRef.error));
      errored++;
      continue;
    }

    // 5b. Resolve entities: per-request entities take priority over shared entities.
    let entitiesForCall: Entities;
    const perRequestEntitiesRaw =
      req.entities !== undefined ? req.entities : null;

    if (perRequestEntitiesRaw !== null) {
      const perArr = parseEntitiesValue(perRequestEntitiesRaw);
      if (perArr === null) {
        decisions.push(
          errorDecision(i, principalStr, actionStr, resourceStr, "Invalid entities: must be a JSON array or AVP entity_list object")
        );
        errored++;
        continue;
      }
      // Format-detect against the per-request entities
      const detection = detectFormat(perArr, req.principal, req.action, req.resource);
      const normalized = normalizeEntities(perArr, detection.format);
      entitiesForCall = normalized as Entities;
    } else if (sharedEntitiesArray !== null) {
      // Reuse shared entities — format-detect against this request's refs
      const detection = detectFormat(sharedEntitiesArray, req.principal, req.action, req.resource);
      const normalized = normalizeEntities(sharedEntitiesArray, detection.format);
      entitiesForCall = normalized as Entities;
    } else {
      // No entities at all — pass empty array (Cedar will evaluate without entity data)
      entitiesForCall = [] as unknown as Entities;
    }

    // 5c. Resolve per-request schema override (rare; falls back to batch schema)
    let callSchema: Schema | undefined = schema;
    if (req.schema !== undefined) {
      if (typeof req.schema === "string") {
        callSchema = parseSchema(req.schema);
      } else {
        callSchema = req.schema as Schema;
      }
    }

    // 5d. Parse context
    let context: Record<string, CedarValueJson> = {};
    if (req.context !== undefined) {
      if (typeof req.context === "string") {
        try {
          context = JSON.parse(req.context) as Record<string, CedarValueJson>;
        } catch {
          decisions.push(
            errorDecision(i, principalStr, actionStr, resourceStr, "context is not valid JSON")
          );
          errored++;
          continue;
        }
      } else if (typeof req.context === "object" && req.context !== null) {
        context = req.context as Record<string, CedarValueJson>;
      }
    }

    // 5e. Build the authorization call
    const call: AuthorizationCall = {
      principal: principalRef,
      action: actionRef,
      resource: resourceRef,
      context,
      policies: { staticPolicies: policiesText },
      entities: entitiesForCall,
      ...(callSchema ? { schema: callSchema, validateRequest: true } : {}),
    };

    // 5f. Call Cedar WASM
    const answer = isAuthorized(call);

    if (answer.type === "failure") {
      // Cedar returned a hard failure (e.g. schema validation error, entity deserialization error).
      // This maps to decision "Error" — not a policy Deny.
      const msg = answer.errors.map((e) => e.message).join("; ");
      decisions.push(errorDecision(i, principalStr, actionStr, resourceStr, msg));
      errored++;
      continue;
    }

    const { decision, diagnostics } = answer.response;
    const isAllow = decision === "allow";

    decisions.push({
      index: i,
      principal: principalStr,
      action: actionStr,
      resource: resourceStr,
      decision: isAllow ? "Allow" : "Deny",
      determining_policies: diagnostics.reason,
    });

    if (isAllow) {
      allowed++;
    } else {
      denied++;
    }
  }

  const total = rawRequests.length;
  const summary = `${total} request${total === 1 ? "" : "s"}: ${allowed} Allow, ${denied} Deny, ${errored} Error`;

  return { total, allowed, denied, errored, decisions, summary };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseSchema(raw: string): Schema {
  try {
    return JSON.parse(raw) as Schema;
  } catch {
    return raw as unknown as Schema;
  }
}

/**
 * Parse entities from a JSON string, unwrapping AVP entity_list envelopes.
 * Returns null on parse failure.
 */
function parseEntitiesString(raw: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return extractEntityArray(parsed);
}

/**
 * Parse entities from an already-parsed value (used for per-request entities
 * that may be a string or an already-parsed array/object).
 */
function parseEntitiesValue(raw: unknown): unknown[] | null {
  if (typeof raw === "string") {
    return parseEntitiesString(raw);
  }
  return extractEntityArray(raw);
}

/** Unwrap AVP entity_list / entityList / EntityList envelope, or return array as-is. */
function extractEntityArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    const list = obj["entity_list"] ?? obj["entityList"] ?? obj["EntityList"];
    if (Array.isArray(list)) return list;
  }
  return null;
}

function refToString(ref: unknown): string {
  if (typeof ref === "string") return ref;
  return JSON.stringify(ref);
}

function errorDecision(
  index: number,
  principal: string,
  action: string,
  resource: string,
  error: string
): BatchDecision {
  return { index, principal, action, resource, decision: "Error", error };
}

function zeroResult(error: string): AuthorizeBatchResult {
  return {
    total: 0,
    allowed: 0,
    denied: 0,
    errored: 0,
    decisions: [],
    summary: error,
  };
}
