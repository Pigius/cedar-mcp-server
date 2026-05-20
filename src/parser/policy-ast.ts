/**
 * Shared utilities for walking the PolicyJson AST returned by policyToJson / templateToJson.
 *
 * AST shape proven in spike (2026-05-19):
 *   - principal/action/resource: { op: "All" | "==" | "in", entity?, entities?, slot? }
 *   - "in" with single entity  → entity key (singular)
 *   - "in" with multiple       → entities key (plural)
 *   - conditions: [{ kind: "when"|"unless", body: ExprTree }]
 *   - ExprTree: operator-as-key encoding ("==", "&&", "||", "has", ".", "Var", "Value")
 *   - Entity literals in scope: { type, id }
 *   - Entity literals in conditions: { "Value": { "__entity": { type, id } } }
 */

import type { PolicyJson, Clause, Expr } from "@cedar-policy/cedar-wasm/nodejs";

// ─── Scope description ───────────────────────────────────────────────────────

export function describePrincipal(principal: PolicyJson["principal"]): string {
  switch (principal.op) {
    case "All":
      return "any principal";
    case "==": {
      const e = "entity" in principal ? principal.entity : null;
      const s = "slot" in principal ? principal.slot : null;
      if (s) return `principal bound to slot ${s}`;
      if (e && "type" in e) return `exactly ${e.type}::"${e.id}"`;
      return "exactly (unknown)";
    }
    case "in": {
      const entities = resolveInEntities(principal);
      if (entities.length === 1) return `principal in ${formatEntity(entities[0]!)}`;
      return `principal in [${entities.map(formatEntity).join(", ")}]`;
    }
    default:
      return "principal (unknown constraint)";
  }
}

export function describeAction(action: PolicyJson["action"]): string {
  switch (action.op) {
    case "All":
      return "any action";
    case "==": {
      const e = "entity" in action ? action.entity : null;
      if (e && "type" in e) return `action ${formatEntity(e)}`;
      return "exactly (unknown action)";
    }
    case "in": {
      const entities = resolveInEntities(action);
      if (entities.length === 1) return `action in ${formatEntity(entities[0]!)}`;
      return `action in [${entities.map(formatEntity).join(", ")}]`;
    }
    default:
      return "action (unknown constraint)";
  }
}

export function describeResource(resource: PolicyJson["resource"]): string {
  switch (resource.op) {
    case "All":
      return "any resource";
    case "==": {
      const e = "entity" in resource ? resource.entity : null;
      const s = "slot" in resource ? resource.slot : null;
      if (s) return `resource bound to slot ${s}`;
      if (e && "type" in e) return `exactly ${e.type}::"${e.id}"`;
      return "exactly (unknown)";
    }
    case "in": {
      const entities = resolveInEntities(resource);
      if (entities.length === 1) return `resource in ${formatEntity(entities[0]!)}`;
      return `resource in [${entities.map(formatEntity).join(", ")}]`;
    }
    default:
      return "resource (unknown constraint)";
  }
}

// ─── Condition rendering ──────────────────────────────────────────────────────

export function describeCondition(clause: Clause): string {
  const kindLabel = clause.kind === "when" ? "WHEN" : "UNLESS";
  const bodyDesc = describeExpr(clause.body);
  return `${kindLabel} ${bodyDesc}`;
}

function describeExpr(expr: Expr): string {
  if (typeof expr !== "object" || expr === null) return String(expr);

  // Var node: { "Var": "principal" | "action" | "resource" | "context" }
  if ("Var" in expr) return String((expr as Record<string, unknown>)["Var"]);

  // Value node: { "Value": <cedar-value> }
  if ("Value" in expr) return formatValue((expr as Record<string, unknown>)["Value"]);

  // Attribute access: { ".": { left, attr } }
  if ("." in expr) {
    const node = (expr as Record<string, unknown>)["."] as { left: Expr; attr: string };
    return `${describeExpr(node.left)}.${node.attr}`;
  }

  // Equality: { "==": { left, right } }
  if ("==" in expr) {
    const node = (expr as Record<string, unknown>)["=="] as { left: Expr; right: Expr };
    return `${describeExpr(node.left)} == ${describeExpr(node.right)}`;
  }

  // Inequality
  if ("!=" in expr) {
    const node = (expr as Record<string, unknown>)["!="] as { left: Expr; right: Expr };
    return `${describeExpr(node.left)} != ${describeExpr(node.right)}`;
  }

  // Logical AND: { "&&": { left, right } }
  if ("&&" in expr) {
    const node = (expr as Record<string, unknown>)["&&"] as { left: Expr; right: Expr };
    return `${describeExpr(node.left)} AND ${describeExpr(node.right)}`;
  }

  // Logical OR: { "||": { left, right } }
  if ("||" in expr) {
    const node = (expr as Record<string, unknown>)["||"] as { left: Expr; right: Expr };
    return `(${describeExpr(node.left)} OR ${describeExpr(node.right)})`;
  }

  // Has (optional attribute check): { "has": { left, attr } }
  if ("has" in expr) {
    const node = (expr as Record<string, unknown>)["has"] as { left: Expr; attr: string };
    return `${describeExpr(node.left)} has '${node.attr}'`;
  }

  // In (membership): { "in": { left, right } }
  if ("in" in expr) {
    const node = (expr as Record<string, unknown>)["in"] as { left: Expr; right: Expr };
    return `${describeExpr(node.left)} in ${describeExpr(node.right)}`;
  }

  // Set literal: { "Set": Expr[] }
  if ("Set" in expr) {
    const items = (expr as Record<string, unknown>)["Set"] as Expr[];
    return `[${items.map(describeExpr).join(", ")}]`;
  }

  // Negation: { "!": { arg } }
  if ("!" in expr) {
    const node = (expr as Record<string, unknown>)["!"] as { arg: Expr };
    return `NOT(${describeExpr(node.arg)})`;
  }

  // contains() call appears as an ExtFuncCall: { "contains": [left, right] }
  // ExtFuncCall is {} & Record<string, Expr[]> — operator is the key, value is args array
  const keys = Object.keys(expr);
  if (keys.length === 1 && Array.isArray((expr as Record<string, unknown>)[keys[0]!])) {
    const fn = keys[0]!;
    const args = (expr as Record<string, unknown>)[fn] as Expr[];
    return `${describeExpr(args[0]!)}.${fn}(${args.slice(1).map(describeExpr).join(", ")})`;
  }

  return "complex condition";
}

// ─── Pattern detection ────────────────────────────────────────────────────────

export function detectPatterns(json: PolicyJson): string[] {
  const patterns: string[] = [];

  if (json.effect === "forbid") patterns.push("forbid_policy");

  // Principal scope patterns
  if (json.principal.op === "in") patterns.push("role_based_access");
  if (json.principal.op === "All") patterns.push("any_principal");
  if (json.principal.op === "==" && "slot" in json.principal) patterns.push("template_policy", "slot_principal");

  // Action scope patterns
  if (json.action.op === "All") patterns.push("unrestricted_action");

  // Resource scope patterns
  if (json.resource.op === "All") patterns.push("unrestricted_resource");
  if (json.resource.op === "==" && "slot" in json.resource) {
    if (!patterns.includes("template_policy")) patterns.push("template_policy");
    patterns.push("slot_resource");
  }

  // Condition patterns
  const allConditionText = json.conditions.map((c) => JSON.stringify(c)).join(" ");

  if (json.conditions.some((c) => c.kind === "unless")) patterns.push("role_exemption");
  if (allConditionText.includes('"has"')) patterns.push("optional_attribute_guard");
  if (allConditionText.includes("contains")) patterns.push("attribute_containment_check");

  // Name-based identity: principal.name == "..."
  if (allConditionText.includes('"name"') && allConditionText.includes('"Var":"principal"')) {
    patterns.push("name_based_identity");
  }

  // Attribute-based conditions (when clause present and non-trivial)
  if (json.conditions.length > 0 && !patterns.includes("role_exemption")) {
    patterns.push("attribute_condition");
  }

  return [...new Set(patterns)];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Handles the entity vs entities asymmetry from policyToJson */
function resolveInEntities(
  constraint: Record<string, unknown>
): Array<{ type: string; id: string }> {
  if ("entities" in constraint && Array.isArray(constraint["entities"])) {
    return constraint["entities"] as Array<{ type: string; id: string }>;
  }
  if ("entity" in constraint && constraint["entity"]) {
    return [constraint["entity"] as { type: string; id: string }];
  }
  return [];
}

function formatEntity(e: { type: string; id: string } | unknown): string {
  if (e && typeof e === "object" && "type" in e && "id" in e) {
    const entity = e as { type: string; id: string };
    return `${entity.type}::"${entity.id}"`;
  }
  return JSON.stringify(e);
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  // Entity literal inside condition body: { __entity: { type, id } }
  if (typeof v === "object" && v !== null && "__entity" in v) {
    const entity = (v as Record<string, unknown>)["__entity"] as { type: string; id: string };
    return formatEntity(entity);
  }
  if (Array.isArray(v)) return `[${v.map(formatValue).join(", ")}]`;
  return JSON.stringify(v);
}
