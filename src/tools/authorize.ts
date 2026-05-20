import { isAuthorized } from "@cedar-policy/cedar-wasm/nodejs";
import type { AuthorizationCall, CedarValueJson, Entities, Schema } from "@cedar-policy/cedar-wasm/nodejs";
import {
  detectFormat,
  normalizeEntities,
  normalizePrincipalRef,
} from "../utils/format-detector.js";
import type { FormatDetectionResult } from "../utils/format-detector.js";

export interface AuthorizeInput {
  policies: string;
  principal: string | Record<string, unknown>;
  action: string | Record<string, unknown>;
  resource: string | Record<string, unknown>;
  entities: string;
  schema?: string;
  context?: string;
}

export interface AuthorizeResult {
  decision: "Allow" | "Deny";
  determining_policies: string[];
  errors: string[];
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
    policies: { staticPolicies: input.policies },
    entities: normalizedEntities as Entities,
    ...(schema ? { schema, validateRequest: true } : {}),
  };

  // per spike-report-wasm-api.md §1: type field is "success"|"failure" for WASM health,
  // decision is "allow"|"deny" for the authorization result
  const answer = isAuthorized(call);

  if (answer.type === "failure") {
    return {
      decision: "Deny",
      determining_policies: [],
      errors: answer.errors.map((e) => e.message),
      format_detected: detection.format,
      format_note: detection.note,
    };
  }

  const { decision, diagnostics } = answer.response;

  return {
    decision: decision === "allow" ? "Allow" : "Deny",
    determining_policies: diagnostics.reason,
    errors: diagnostics.errors.map((e) => e.error.message),
    format_detected: detection.format,
    format_note: detection.note,
  };
}
