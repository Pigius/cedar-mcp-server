import { isAuthorized } from "@cedar-policy/cedar-wasm/nodejs";
import type { AuthorizationCall, Entities, Schema } from "@cedar-policy/cedar-wasm/nodejs";

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
}

function parseEntityRef(ref: string): { type: string; id: string } {
  // Parses 'Namespace::Type::"id"' into { type: "Namespace::Type", id: "id" }
  const match = ref.match(/^(.+)::"(.+)"$/);
  if (!match) {
    throw new Error(`Invalid entity reference: ${ref}. Expected format: Namespace::Type::"id"`);
  }
  return { type: match[1], id: match[2] };
}

export async function handleAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
  const principal = parseEntityRef(input.principal);
  const action = parseEntityRef(input.action);
  const resource = parseEntityRef(input.resource);

  let entities: Entities;
  try {
    entities = JSON.parse(input.entities);
  } catch {
    throw new Error("entities must be a valid JSON array");
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

  let context: Record<string, unknown> = {};
  if (input.context) {
    try {
      context = JSON.parse(input.context);
    } catch {
      throw new Error("context must be a valid JSON object");
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
