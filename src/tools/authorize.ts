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
 */
function buildStaticPolicies(
  input: AuthorizeInput
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
