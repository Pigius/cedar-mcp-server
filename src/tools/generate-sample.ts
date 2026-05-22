import {
  policyToJson,
  isAuthorized,
  schemaToJsonWithResolvedTypes,
} from "@cedar-policy/cedar-wasm/nodejs";
import type { PolicyJson, Entities, Schema } from "@cedar-policy/cedar-wasm/nodejs";
import {
  extractLikeConstraints,
  patternToString,
  type LikeConstraint,
} from "../parser/policy-ast.js";

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

  // "like" is handled separately via extractLikeConstraints — skip here
  if ("like" in e) return;

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

  // in (set membership in condition body): { "in": { left: attrExpr, right: SetExpr } }
  // e.g. resource.status in ["active", "pending"]
  if ("in" in e && clauseKind === "when") {
    const node = e["in"] as { left: unknown; right: unknown };
    const attr = extractAttrAccess(node.left);
    const right = node.right as Record<string, unknown>;
    if (attr && "Set" in right) {
      const values = (right["Set"] as unknown[]).map(extractValue).filter((v) => v !== undefined);
      if (values.length > 0) {
        constraints.push({ variable: attr.variable, attr: attr.attr, op: "contains", values });
      }
    }
    return;
  }

  // contains(): { "contains": { "left": setExpr, "right": attrExpr } }
  // e.g. ["active", "pending"].contains(resource.status)
  if ("contains" in e && !Array.isArray(e["contains"]) && typeof e["contains"] === "object") {
    const node = e["contains"] as { left: unknown; right: unknown };
    const setExpr = node.left as Record<string, unknown>;
    const attrExpr = node.right;
    if ("Set" in setExpr && clauseKind === "when") {
      const attr = extractAttrAccess(attrExpr);
      const values = (setExpr["Set"] as unknown[]).map(extractValue).filter((v) => v !== undefined);
      if (attr && values.length > 0) {
        constraints.push({ variable: attr.variable, attr: attr.attr, op: "contains", values });
      }
    }
    return;
  }
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

/**
 * Returns required attributes for an entity type from the (resolved) schema JSON.
 * Only includes `required: true` attributes — optional ones are omitted unless
 * the policy conditions explicitly reference them.
 * Returns a map of attrName → default value based on Cedar type.
 */
function requiredAttrsFromSchema(
  schemaJson: unknown,
  namespace: string,
  entityTypeName: string
): Record<string, unknown> {
  try {
    const ns = (schemaJson as Record<string, unknown>)?.[namespace] as Record<string, unknown>;
    const entityTypes = ns?.["entityTypes"] as Record<string, unknown>;
    // entityTypeName may be fully-qualified "Ns::Type" or just "Type"
    const simpleTypeName = entityTypeName.includes("::")
      ? entityTypeName.split("::").pop()!
      : entityTypeName;
    const entityDef = entityTypes?.[simpleTypeName] as Record<string, unknown>;
    const shape = entityDef?.["shape"] as Record<string, unknown>;
    const attributes = shape?.["attributes"] as Record<string, Record<string, unknown>>;
    if (!attributes) return {};

    const defaults: Record<string, unknown> = {};
    for (const [attrName, attrDef] of Object.entries(attributes)) {
      // Cedar JSON-schema default for `required` is true (per the official
      // spec); only attributes with an explicit `required: false` are optional.
      // The old `!== true` check skipped attributes when the JSON omitted the
      // flag entirely, which is the shape `schemaToJsonWithResolvedTypes`
      // emits for cedarschema-text input like `entity User { name: String }`.
      // Empty-attrs entities then failed `validateRequest` once the schema
      // was supplied to the internal verification call (kickoff-14 14d audit
      // Finding F3 follow-on).
      if (attrDef["required"] === false) continue;
      const typeName = (attrDef["type"] as string | undefined)?.toLowerCase() ?? "";
      if (typeName === "string") defaults[attrName] = "";
      else if (typeName === "long") defaults[attrName] = 0;
      else if (typeName === "boolean") defaults[attrName] = false;
      // Records, Sets, extension types: leave to the caller to set meaningfully
    }
    return defaults;
  } catch {
    return {};
  }
}

/**
 * Qualify a bare entity-type name with the schema's namespace. If the name
 * already carries a `::` separator (which `schemaToJsonWithResolvedTypes`
 * emits for entries declared inside `namespace X { ... }` cedarschema text),
 * return it verbatim — re-prefixing produces `MyApp::MyApp::User` style
 * double-namespace artifacts (kickoff-14 14b).
 */
function qualifyEntityType(typeName: string, namespace: string): string {
  if (typeName.includes("::")) return typeName;
  return namespace ? `${namespace}::${typeName}` : typeName;
}

function entityTypesFromSchema(
  schemaJson: unknown,
  namespace: string,
  actionId: string | undefined
): { principalType: string; resourceType: string } {
  try {
    const ns = (schemaJson as Record<string, unknown>)?.[namespace] as Record<string, unknown>;
    const actions = ns?.["actions"] as Record<string, unknown>;
    const actionKey = actionId ? actions?.[actionId] : Object.values(actions ?? {})[0];
    const appliesTo = (actionKey as Record<string, unknown>)?.["appliesTo"] as Record<string, unknown>;
    const principalTypes = appliesTo?.["principalTypes"] as string[] | undefined;
    const resourceTypes = appliesTo?.["resourceTypes"] as string[] | undefined;
    return {
      principalType: principalTypes?.[0] ? qualifyEntityType(principalTypes[0], namespace) : qualifyEntityType("User", namespace),
      resourceType: resourceTypes?.[0] ? qualifyEntityType(resourceTypes[0], namespace) : qualifyEntityType("Resource", namespace),
    };
  } catch {
    return { principalType: qualifyEntityType("User", namespace), resourceType: qualifyEntityType("Resource", namespace) };
  }
}

function extractScope(json: PolicyJson, schemaNamespace: string, schemaJson?: unknown): ScopeInfo {
  // qualifyEntityType handles the empty-namespace case (Cedar's "" namespace
  // for namespaceless schemas) by returning bare "Action" instead of "::Action".
  const actionType = qualifyEntityType("Action", schemaNamespace);

  let actionId: string | undefined;
  let principalRoleType: string | undefined;
  let principalRoleId: string | undefined;
  // Direct principal/resource type pins (from `principal == Type::"id"` /
  // `resource == Type::"id"`). When present, these override the
  // schema-derived defaults so the generated request matches what the
  // policy explicitly scoped to.
  let pinnedPrincipalType: string | undefined;
  let pinnedResourceType: string | undefined;

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

  // Extract principal from scope.
  //
  // `op === "in"` is the role-membership pattern: principal in Role::"X".
  //   We record principalRoleType + principalRoleId so the entity builder
  //   can attach the role as a parent.
  //
  // `op === "=="` is the direct pin: principal == User::"alice".
  //   The principal type itself is information the generator needs (it
  //   tells us which entity type to instantiate). Without this, the
  //   generator fell back to schema-derived defaults that didn't always
  //   match the policy's principal pin — caught by a regression test on
  //   defaultActionIdFromSchema when the schema's first action's
  //   appliesTo.principalTypes disagreed with the policy's pinned type.
  if (json.principal.op === "in") {
    const e = "entity" in json.principal ? (json.principal as Record<string, unknown>)["entity"] as { type: string; id: string } : null;
    if (e) {
      principalRoleType = e.type;
      principalRoleId = e.id;
    }
  } else if (json.principal.op === "==") {
    const e = "entity" in json.principal ? (json.principal as Record<string, unknown>)["entity"] as { type: string; id: string } : null;
    if (e) {
      pinnedPrincipalType = e.type;
    }
  }

  // Same handling for resource direct-pin.
  if (json.resource.op === "==") {
    const e = "entity" in json.resource ? (json.resource as Record<string, unknown>)["entity"] as { type: string; id: string } : null;
    if (e) {
      pinnedResourceType = e.type;
    }
  }

  const derived = entityTypesFromSchema(schemaJson, schemaNamespace, actionId);
  const principalType = pinnedPrincipalType ?? derived.principalType;
  const resourceType = pinnedResourceType ?? derived.resourceType;

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

/**
 * Pick a default action id when the policy scope doesn't specify one.
 *
 * Original fallback was a hardcoded `"READ"` (uppercase) which mismatched
 * schemas declaring lowercase action keys (e.g. `actions: { read: { ... } }`).
 * Cedar's request validator then rejected the request because `Action::"READ"`
 * isn't declared, causing a default-deny that contradicted the generator's
 * own `decision: "Allow"` self-report. Caught by e2e behavior test B3.
 *
 * The fix evolved through two iterations:
 *
 *   v1: return Object.keys(actions)[0] — picked the first declared action.
 *       Broke when the schema's first action had `appliesTo.principalTypes`
 *       that didn't include the scope's principal type. Example:
 *         { adminOnly: { appliesTo: ["Admin"] }, read: { appliesTo: ["User"] } }
 *       with a policy targeting `User` would pick `adminOnly`, then schema
 *       validation rejects because the principal type doesn't apply.
 *
 *   v2 (this version): find an action whose `appliesTo.principalTypes` includes
 *       the scope's bare principal type (e.g. "User" extracted from
 *       "DocMgmt::User"). Falls back to the first action only if no match.
 *       Final fallback is lowercase "read" when no schema is supplied at all.
 */
function defaultActionIdFromSchema(
  schemaJson: unknown,
  namespace: string,
  principalType?: string  // full namespaced form like "DocMgmt::User"
): string {
  try {
    const ns = (schemaJson as Record<string, unknown>)?.[namespace] as Record<string, unknown> | undefined;
    const actions = ns?.["actions"] as Record<string, Record<string, unknown>> | undefined;
    if (!actions) return "read";

    const keys = Object.keys(actions);
    if (keys.length === 0) return "read";

    // Extract bare principal type name ("User" from "DocMgmt::User") for matching
    // against the schema's appliesTo.principalTypes (which are stored unprefixed).
    const barePrincipalType = principalType
      ? principalType.split("::").pop()
      : undefined;

    if (barePrincipalType) {
      for (const key of keys) {
        const appliesTo = actions[key]?.["appliesTo"] as Record<string, unknown> | undefined;
        const principalTypes = appliesTo?.["principalTypes"] as string[] | undefined;
        if (principalTypes && principalTypes.includes(barePrincipalType)) {
          return key;
        }
      }
    }

    // No action has appliesTo matching the scope's principal type, OR no principal
    // type was passed. Fall back to first declared action — better than the old
    // hardcoded "READ" because at least it's a real declared action.
    return keys[0]!;
  } catch { /* fall through */ }
  return "read";
}

function buildEntities(
  scope: ScopeInfo,
  constraints: AttributeConstraint[],
  targetDecision: "allow" | "deny",
  schemaNamespace: string,
  likeConstraints: LikeConstraint[] = [],
  schemaJson?: unknown
): { entities: EntityPayload[]; principalId: string; actionId: string; resourceId: string } {
  const principalId = "sample-principal";
  const resourceId = "sample-resource";
  const actionId = scope.actionId ?? defaultActionIdFromSchema(schemaJson, schemaNamespace, scope.principalType);

  // Seed required attributes from schema so validateRequest: true doesn't fail on missing fields.
  // Condition-derived values (eq, has, contains, like) overwrite these defaults below.
  const principalAttrs: Record<string, unknown> = schemaJson
    ? requiredAttrsFromSchema(schemaJson, schemaNamespace, scope.principalType)
    : {};
  const resourceAttrs: Record<string, unknown> = schemaJson
    ? requiredAttrsFromSchema(schemaJson, schemaNamespace, scope.resourceType)
    : {};

  // For deny, prefer violating a "has" constraint first, then "contains"/"eq".
  // Omitting an optional attribute is the clearest deny signal.
  let violatedConstraint: AttributeConstraint | null = null;
  if (targetDecision === "deny") {
    violatedConstraint =
      constraints.find((c) => c.op === "has" && c.variable === "resource") ??
      constraints.find((c) => c.op === "has" && c.variable === "principal") ??
      constraints.find((c) => c.op === "contains") ??
      constraints.find((c) => c.op === "eq") ??
      null;
  }

  for (const c of constraints) {
    const shouldSatisfy = targetDecision === "allow" || c !== violatedConstraint;

    if (c.variable === "principal") {
      if (c.op === "eq" && shouldSatisfy) principalAttrs[c.attr] = c.value;
      if (c.op === "eq" && !shouldSatisfy) principalAttrs[c.attr] = `__deny_${c.attr}`;
      if (c.op === "contains" && shouldSatisfy) principalAttrs[c.attr] = c.values?.[0];
      if (c.op === "contains" && !shouldSatisfy) principalAttrs[c.attr] = `__deny_not_in_set`;
    }

    if (c.variable === "resource") {
      // If we're denying by omitting this attr (has-violated), skip its eq constraint too
      const attrOmittedByDeny =
        violatedConstraint?.op === "has" &&
        violatedConstraint.variable === "resource" &&
        violatedConstraint.attr === c.attr;

      if (c.op === "eq" && shouldSatisfy && !attrOmittedByDeny) resourceAttrs[c.attr] = c.value;
      if (c.op === "eq" && !shouldSatisfy) resourceAttrs[c.attr] = `__deny_${c.attr}`;
      // contains/in: pick first value from set for allow, sentinel not in set for deny
      if (c.op === "contains" && shouldSatisfy) resourceAttrs[c.attr] = c.values?.[0];
      if (c.op === "contains" && !shouldSatisfy) resourceAttrs[c.attr] = `__deny_not_in_set`;
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

  // Apply like-based attribute generation.
  // For deny: negative like (depth-limit) takes priority over eq-violation for the same attribute —
  // it produces a more educational value (e.g. "/api/v1/projects/x/x" beats "__deny_path").
  const attrsWithNegativeLike = new Set(
    likeConstraints
      .filter((lc) => lc.negated && targetDecision === "deny")
      .map((lc) => `${lc.variable}.${lc.attr}`)
  );

  for (const lc of likeConstraints) {
    const target = lc.variable === "resource" ? resourceAttrs : principalAttrs;
    const key = `${lc.variable}.${lc.attr}`;
    // Allow: skip if already set by an eq constraint (== covers the allow case via ||)
    // Deny: skip only if there's no negative like for this attr (eq-violation is the fallback)
    if (target[lc.attr] !== undefined && !(targetDecision === "deny" && attrsWithNegativeLike.has(key))) continue;

    if (targetDecision === "allow" && !lc.negated) {
      target[lc.attr] = patternToString(lc.pattern, "x");
    } else if (targetDecision === "deny" && lc.negated) {
      // Satisfying the negative pattern makes !like false → deny
      target[lc.attr] = patternToString(lc.pattern, "x");
    } else if (targetDecision === "deny" && !lc.negated) {
      // No negative pattern to exploit — use a non-matching prefix
      // Validation loop will catch if this doesn't produce a deny
      if (target[lc.attr] === undefined) target[lc.attr] = "/deny/path";
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

  // Extract namespace and schema JSON for entity type lookup.
  // schemaToJsonWithResolvedTypes only accepts Cedar text — for JSON schemas, parse directly.
  //
  // Cedar's "namespaceless" schema uses an empty-string namespace key:
  // `{"": {entityTypes: {...}}}`. Object.keys returns `[""]`, and treating
  // that as truthy via `if (ns)` previously fell through to the hardcoded
  // "MyApp" default, hallucinating a namespace the schema didn't declare.
  // `if (ns !== undefined)` keeps the empty string as a legitimate namespace
  // that downstream `qualifyEntityType` rewrites as no prefix at all
  // (kickoff-14 14d audit Finding F2).
  let schemaNamespace = "MyApp";
  let schemaJson: unknown = undefined;
  try {
    const parsed = JSON.parse(input.schema);
    const ns = Object.keys(parsed)[0];
    if (ns !== undefined) { schemaNamespace = ns; schemaJson = parsed; }
  } catch {
    // Not JSON — try Cedar text schema
    try {
      const schemaResult = schemaToJsonWithResolvedTypes(input.schema);
      if (schemaResult.type === "success") {
        const ns = Object.keys(schemaResult.json)[0];
        if (ns !== undefined) { schemaNamespace = ns; schemaJson = schemaResult.json; }
      }
    } catch {
      // Non-fatal — proceed with default namespace
    }
  }

  // Extract equality/has constraints and like constraints separately
  const constraints: AttributeConstraint[] = extractConstraints(json.conditions);
  const likeConstraints: LikeConstraint[] = extractLikeConstraints(json.conditions);

  const scope = extractScope(json, schemaNamespace, schemaJson);

  // Build entities, passing like constraints for path-matching generation
  const { entities, principalId, actionId, resourceId } = buildEntities(
    scope, constraints, input.target_decision, schemaNamespace, likeConstraints, schemaJson
  );

  const principalRef = `${scope.principalType}::"${principalId}"`;
  const actionRef = `${scope.actionType}::"${actionId}"`;
  const resourceRef = `${scope.resourceType}::"${resourceId}"`;

  // Validate the generated payload with isAuthorized. Pass the user's schema
  // with `validateRequest: true` so a generator-fabricated entity type that
  // doesn't exist in the schema (e.g. when the schema has no namespace and
  // an earlier code path leaked a default like `MyApp::Resource`) flips
  // `ready_to_test` to false instead of falsely claiming the payload is
  // ready (kickoff-14 14d audit Finding F3).
  let verifySchema: Schema | undefined;
  try {
    verifySchema = JSON.parse(input.schema) as Schema;
  } catch {
    verifySchema = input.schema as Schema;
  }
  const authResult = isAuthorized({
    principal: { type: scope.principalType, id: principalId },
    action: { type: scope.actionType, id: actionId },
    resource: { type: scope.resourceType, id: resourceId },
    context: {},
    policies: { staticPolicies: input.policy },
    entities: entities as Entities,
    schema: verifySchema,
    validateRequest: true,
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

  let actualDecision: "Allow" | "Deny" = authResult.response.decision === "allow" ? "Allow" : "Deny";
  const targetLabel = input.target_decision === "allow" ? "Allow" : "Deny";

  // Retry once with fallback if initial generation missed the target.
  // For like-deny with no negative pattern, try the opposite wildcard count.
  if (actualDecision !== targetLabel && likeConstraints.length > 0) {
    const fallbackAttrs = { ...entities.find(e => e.uid.type === scope.resourceType)?.attrs ?? {} };
    for (const lc of likeConstraints.filter(l => !l.negated && l.variable === "resource")) {
      // For deny fallback: try a completely off-prefix path
      if (input.target_decision === "deny") fallbackAttrs[lc.attr] = "/deny/path/mismatch";
      // For allow fallback: try two wildcard segments (sometimes needed for complex patterns)
      if (input.target_decision === "allow") fallbackAttrs[lc.attr] = patternToString(lc.pattern, "sample");
    }
    const retryEntities = entities.map(e =>
      e.uid.type === scope.resourceType ? { ...e, attrs: fallbackAttrs } : e
    );
    const retryResult = isAuthorized({
      principal: { type: scope.principalType, id: principalId },
      action: { type: scope.actionType, id: actionId },
      resource: { type: scope.resourceType, id: resourceId },
      context: {},
      policies: { staticPolicies: input.policy },
      entities: retryEntities as Entities,
      schema: verifySchema,
      validateRequest: true,
    });
    if (retryResult.type === "success") {
      const retryDecision = retryResult.response.decision === "allow" ? "Allow" : "Deny";
      if (retryDecision === targetLabel) {
        actualDecision = retryDecision;
        entities.splice(0, entities.length, ...retryEntities);
      }
    }
  }

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
