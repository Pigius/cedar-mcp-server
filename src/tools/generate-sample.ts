import {
  policyToJson,
  isAuthorized,
  schemaToJsonWithResolvedTypes,
} from "@cedar-policy/cedar-wasm/nodejs";
import type { PolicyJson, Entities, Schema } from "@cedar-policy/cedar-wasm/nodejs";

export interface GenerateSampleInput {
  policy: string;
  schema: string;
  target_decision: "allow" | "deny";
}

export interface EntityPayload {
  uid: { type: string; id: string };
  attrs: Record<string, unknown>;
  parents: Array<{ type: string; id: string }>;
}

export interface GenerateSampleResult {
  principal: string;
  action: string;
  resource: string;
  entities: EntityPayload[];
  explanation: string;
  decision?: "Allow" | "Deny";
  ready_to_test?: boolean;
  error?: string;
}

// ─── Constraint extraction ────────────────────────────────────────────────────

interface AttributeConstraint {
  variable: "principal" | "resource" | "context";
  attr: string;
  op: "eq" | "contains" | "has" | "not_has";
  value?: unknown;
  values?: unknown[];
}

function extractConstraints(conditions: PolicyJson["conditions"]): AttributeConstraint[] {
  const constraints: AttributeConstraint[] = [];
  for (const clause of conditions) {
    walkExpr(clause.body, clause.kind, constraints);
  }
  return constraints;
}

function walkExpr(
  expr: unknown,
  clauseKind: "when" | "unless",
  constraints: AttributeConstraint[]
): void {
  if (typeof expr !== "object" || expr === null) return;
  const e = expr as Record<string, unknown>;

  // Check for unsupported "like" operator
  if ("like" in e) {
    throw new Error("path-matching conditions (like) not yet supported by cedar_generate_sample_request");
  }

  if ("&&" in e || "||" in e) {
    const key = "&&" in e ? "&&" : "||";
    const node = e[key] as { left: unknown; right: unknown };
    walkExpr(node.left, clauseKind, constraints);
    walkExpr(node.right, clauseKind, constraints);
    return;
  }

  // Equality: principal.attr == value  or  resource.attr == value
  if ("==" in e) {
    const node = e["=="] as { left: unknown; right: unknown };
    const attr = extractAttrAccess(node.left);
    if (attr && clauseKind === "when") {
      const value = extractValue(node.right);
      if (value !== undefined) {
        constraints.push({ variable: attr.variable, attr: attr.attr, op: "eq", value });
      }
    }
    return;
  }

  // Has (optional attribute guard): resource has attr
  if ("has" in e) {
    const node = e["has"] as { left: unknown; attr: string };
    const varName = extractVar(node.left);
    if (varName && (varName === "principal" || varName === "resource")) {
      if (clauseKind === "when") {
        constraints.push({ variable: varName, attr: node.attr, op: "has" });
      } else {
        constraints.push({ variable: varName, attr: node.attr, op: "not_has" });
      }
    }
    return;
  }

  // contains(): { "contains": [array_expr, value_expr] } — but policyToJson may encode differently
  // Cedar's [X, Y].contains(attr) appears as an ext func call with key "contains" or similar
  // For now, handle simple in-condition; skip complex ones
}

function extractAttrAccess(
  expr: unknown
): { variable: "principal" | "resource" | "context"; attr: string } | null {
  if (typeof expr !== "object" || expr === null) return null;
  const e = expr as Record<string, unknown>;
  if ("." in e) {
    const node = e["."] as { left: unknown; attr: string };
    const varName = extractVar(node.left);
    if (varName === "principal" || varName === "resource" || varName === "context") {
      return { variable: varName, attr: node.attr };
    }
  }
  return null;
}

function extractVar(expr: unknown): string | null {
  if (typeof expr === "object" && expr !== null && "Var" in (expr as Record<string, unknown>)) {
    return (expr as Record<string, string>)["Var"] ?? null;
  }
  return null;
}

function extractValue(expr: unknown): unknown {
  if (typeof expr !== "object" || expr === null) return undefined;
  const e = expr as Record<string, unknown>;
  if ("Value" in e) {
    const v = e["Value"];
    if (v !== null && typeof v === "object" && "__entity" in (v as Record<string, unknown>)) {
      return undefined; // entity reference — skip for simple attr matching
    }
    return v;
  }
  return undefined;
}

// ─── Scope extraction ─────────────────────────────────────────────────────────

interface ScopeInfo {
  principalType: string;
  principalRoleType?: string;
  principalRoleId?: string;
  actionType: string;
  actionId?: string;
  resourceType: string;
}

function extractScope(json: PolicyJson, schemaNamespace: string): ScopeInfo {
  // Infer entity types from the policy scope and schema namespace
  const principalType = `${schemaNamespace}::User`;
  const resourceType = `${schemaNamespace}::Resource`;
  const actionType = `${schemaNamespace}::Action`;

  let actionId: string | undefined;
  let principalRoleType: string | undefined;
  let principalRoleId: string | undefined;

  // Extract action from scope
  if (json.action.op === "==") {
    const e = "entity" in json.action ? (json.action as Record<string, unknown>)["entity"] as { type: string; id: string } : null;
    if (e) actionId = e.id;
  } else if (json.action.op === "in") {
    const entities = "entities" in json.action
      ? (json.action as Record<string, unknown>)["entities"] as Array<{ type: string; id: string }>
      : "entity" in json.action
        ? [(json.action as Record<string, unknown>)["entity"] as { type: string; id: string }]
        : [];
    if (entities[0]) actionId = entities[0].id;
  }

  // Extract principal role from scope
  if (json.principal.op === "in") {
    const e = "entity" in json.principal ? (json.principal as Record<string, unknown>)["entity"] as { type: string; id: string } : null;
    if (e) {
      principalRoleType = e.type;
      principalRoleId = e.id;
    }
  }

  return {
    principalType,
    principalRoleType,
    principalRoleId,
    actionType,
    actionId,
    resourceType,
  };
}

// ─── Entity building ──────────────────────────────────────────────────────────

function buildEntities(
  scope: ScopeInfo,
  constraints: AttributeConstraint[],
  targetDecision: "allow" | "deny",
  schemaNamespace: string
): { entities: EntityPayload[]; principalId: string; actionId: string; resourceId: string } {
  const principalId = "sample-principal";
  const resourceId = "sample-resource";
  const actionId = scope.actionId ?? "READ";

  const principalAttrs: Record<string, unknown> = {};
  const resourceAttrs: Record<string, unknown> = {};

  // For deny, prefer violating a "has" constraint (omit optional attr) over corrupting an eq value.
  // Omitting an attribute is the clearest deny signal for optional attribute guards.
  let violatedConstraint: AttributeConstraint | null = null;
  if (targetDecision === "deny") {
    violatedConstraint =
      constraints.find((c) => c.op === "has" && c.variable === "resource") ??
      constraints.find((c) => c.op === "has" && c.variable === "principal") ??
      constraints.find((c) => c.op === "eq") ??
      null;
  }

  for (const c of constraints) {
    const shouldSatisfy = targetDecision === "allow" || c !== violatedConstraint;

    if (c.variable === "principal") {
      if (c.op === "eq" && shouldSatisfy) principalAttrs[c.attr] = c.value;
      if (c.op === "eq" && !shouldSatisfy) principalAttrs[c.attr] = `__deny_${c.attr}`;
    }

    if (c.variable === "resource") {
      // If we're denying by omitting this attr (has-violated), skip its eq constraint too
      const attrOmittedByDeny =
        violatedConstraint?.op === "has" &&
        violatedConstraint.variable === "resource" &&
        violatedConstraint.attr === c.attr;

      if (c.op === "eq" && shouldSatisfy && !attrOmittedByDeny) resourceAttrs[c.attr] = c.value;
      if (c.op === "eq" && !shouldSatisfy) resourceAttrs[c.attr] = `__deny_${c.attr}`;
      if (c.op === "has" && shouldSatisfy) {
        // Include the optional attr — set to a neutral value if no eq constraint follows
        const eqForAttr = constraints.find(
          (x) => x.op === "eq" && x.variable === "resource" && x.attr === c.attr
        );
        if (!eqForAttr) resourceAttrs[c.attr] = "present";
      }
      if (c.op === "has" && !shouldSatisfy) {
        // Omit the optional attribute — deny by not having it
        delete resourceAttrs[c.attr];
      }
      if (c.op === "not_has") {
        // This is from an "unless" clause — omit the attr to satisfy the denial condition
        delete resourceAttrs[c.attr];
      }
    }
  }

  const principalEntity: EntityPayload = {
    uid: { type: scope.principalType, id: principalId },
    attrs: principalAttrs,
    parents: scope.principalRoleType && scope.principalRoleId
      ? [{ type: scope.principalRoleType, id: scope.principalRoleId }]
      : [],
  };

  const resourceEntity: EntityPayload = {
    uid: { type: scope.resourceType, id: resourceId },
    attrs: resourceAttrs,
    parents: [],
  };

  const entities: EntityPayload[] = [principalEntity, resourceEntity];

  // Add role entity if needed
  if (scope.principalRoleType && scope.principalRoleId) {
    entities.push({
      uid: { type: scope.principalRoleType, id: scope.principalRoleId },
      attrs: {},
      parents: [],
    });
  }

  return {
    entities,
    principalId,
    actionId,
    resourceId,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleGenerateSample(input: GenerateSampleInput): Promise<GenerateSampleResult> {
  // Parse policy
  const policyResult = policyToJson(input.policy);
  if (policyResult.type === "failure") {
    return { principal: "", action: "", resource: "", entities: [], explanation: "", error: policyResult.errors.map((e) => e.message).join("; ") };
  }
  const json = policyResult.json;

  // Parse schema
  let schemaNamespace = "MyApp";
  try {
    const schemaResult = schemaToJsonWithResolvedTypes(input.schema);
    if (schemaResult.type === "success") {
      const ns = Object.keys(schemaResult.json)[0];
      if (ns) schemaNamespace = ns;
    }
  } catch {
    // Non-fatal — proceed with default namespace
  }

  // Extract constraints — check for unsupported patterns
  let constraints: AttributeConstraint[];
  try {
    constraints = extractConstraints(json.conditions);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { principal: "", action: "", resource: "", entities: [], explanation: "", error: msg };
  }

  const scope = extractScope(json, schemaNamespace);

  // Build entities
  const { entities, principalId, actionId, resourceId } = buildEntities(
    scope, constraints, input.target_decision, schemaNamespace
  );

  const principalRef = `${scope.principalType}::"${principalId}"`;
  const actionRef = `${scope.actionType}::"${actionId}"`;
  const resourceRef = `${scope.resourceType}::"${resourceId}"`;

  // Validate the generated payload with isAuthorized
  const authResult = isAuthorized({
    principal: { type: scope.principalType, id: principalId },
    action: { type: scope.actionType, id: actionId },
    resource: { type: scope.resourceType, id: resourceId },
    context: {},
    policies: { staticPolicies: input.policy },
    entities: entities as Entities,
  });

  if (authResult.type === "failure") {
    return {
      principal: principalRef,
      action: actionRef,
      resource: resourceRef,
      entities,
      explanation: "Authorization check failed during validation.",
      error: authResult.errors.map((e) => e.message).join("; "),
    };
  }

  const actualDecision = authResult.response.decision === "allow" ? "Allow" : "Deny";
  const targetLabel = input.target_decision === "allow" ? "Allow" : "Deny";

  const explanation = actualDecision === targetLabel
    ? `This request will be ${actualDecision.toUpperCase()} as expected.`
    : `Generated payload produced ${actualDecision} instead of expected ${targetLabel}. The policy conditions may be more complex than automated extraction supports.`;

  return {
    principal: principalRef,
    action: actionRef,
    resource: resourceRef,
    entities,
    explanation,
    decision: actualDecision,
    ready_to_test: actualDecision === targetLabel,
  };
}
