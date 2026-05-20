import { isAuthorized } from "@cedar-policy/cedar-wasm/nodejs";
import type { AuthorizationCall, CedarValueJson, Entities, Schema } from "@cedar-policy/cedar-wasm/nodejs";

export interface AuthorizeInput {
  policies: string;
  principal: string;
  action: string;
  resource: string;
  entities: string;
  schema?: string;
  context?: string;
}

export interface AuthorizeResult {
  decision: "Allow" | "Deny";
  determining_policies: string[];
  errors: string[];
  error?: string;
}

function parseEntityRef(ref: string): { type: string; id: string } {
  // Parses 'Namespace::Type::"id"' into { type: "Namespace::Type", id: "id" }
  const match = ref.match(/^(.+)::"(.+)"$/);
  if (!match) {
    throw new Error(`Invalid entity reference: ${ref}. Expected format: Namespace::Type::"id"`);
  }
  return { type: match[1], id: match[2] };
}

const DENY_RESULT = (error: string): AuthorizeResult => ({
  decision: "Deny",
  determining_policies: [],
  errors: [],
  error,
});

export async function handleAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
  let principal: { type: string; id: string };
  let action: { type: string; id: string };
  let resource: { type: string; id: string };
  try {
    principal = parseEntityRef(input.principal);
    action = parseEntityRef(input.action);
    resource = parseEntityRef(input.resource);
  } catch (e) {
    return DENY_RESULT(e instanceof Error ? e.message : String(e));
  }

  let entities: Entities;
  try {
    entities = JSON.parse(input.entities);
  } catch {
    return DENY_RESULT("entities must be a valid JSON array");
  }

  let schema: Schema | undefined;
  if (input.schema) {
    try {
      schema = JSON.parse(input.schema);
    } catch {
      // Treat as Cedar text schema if not valid JSON
      schema = input.schema;
    }
  }

  let context: Record<string, CedarValueJson> = {};
  if (input.context) {
    try {
      context = JSON.parse(input.context);
    } catch {
      return DENY_RESULT("context must be a valid JSON object");
    }
  }

  const call: AuthorizationCall = {
    principal,
    action,
    resource,
    context,
    policies: { staticPolicies: input.policies },
    entities,
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
    };
  }

  const { decision, diagnostics } = answer.response;

  return {
    decision: decision === "allow" ? "Allow" : "Deny",
    determining_policies: diagnostics.reason,
    errors: diagnostics.errors.map((e) => e.error.message),
  };
}
