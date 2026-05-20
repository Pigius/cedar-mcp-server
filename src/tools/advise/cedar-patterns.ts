/**
 * Cedar design pattern definitions and classifier.
 * Patterns proven from official docs 2026-05-20:
 * https://docs.cedarpolicy.com/overview/patterns.html
 */

import type { PolicyJson } from "@cedar-policy/cedar-wasm/nodejs";

export type CedarPattern = "membership" | "relationship" | "discretionary" | "hybrid" | "unknown";

export interface PatternClassification {
  pattern: CedarPattern;
  confidence: "high" | "medium" | "low";
  evidence: string;
}

/**
 * Classify a single policy's primary Cedar pattern from its policyToJson AST.
 *
 * Membership (RBAC):  principal in Role::"X"  — scope uses "in" with a non-resource entity
 * Relationship (ReBAC): principal in resource.attr — condition body has "in" with resource attribute
 * Discretionary: principal == Service::"specific"  — scope uses "==" (specific entity)
 * Hybrid: combination of the above
 */
export function classifyPolicy(json: PolicyJson): PatternClassification {
  const principalOp = json.principal.op;
  const conditionsText = JSON.stringify(json.conditions);

  // Relationship: condition body contains "principal in resource" — ReBAC
  const hasReBAC = conditionsText.includes('"in"') &&
    conditionsText.includes('"Var":"principal"') &&
    conditionsText.includes('"Var":"resource"');

  // Membership: principal scope is "in" (role/group membership, not via condition)
  const isMembership = principalOp === "in" && !hasReBAC;

  // Discretionary: principal scope is "==" (specific entity)
  const isDiscretionary = principalOp === "==";

  if (hasReBAC && isMembership) {
    return { pattern: "hybrid", confidence: "medium", evidence: "principal scope uses 'in' (Membership) and conditions use principal-in-resource pattern (Relationship)" };
  }
  if (hasReBAC) {
    return { pattern: "relationship", confidence: "high", evidence: "condition body contains principal-in-resource relationship check" };
  }
  if (isMembership) {
    return { pattern: "membership", confidence: "high", evidence: `principal scope uses 'in' — group/role membership (RBAC)` };
  }
  if (isDiscretionary) {
    return { pattern: "discretionary", confidence: "high", evidence: `principal scope uses '==' — specific entity grant (Discretionary)` };
  }
  if (principalOp === "All") {
    return { pattern: "unknown", confidence: "low", evidence: "principal is unconstrained in scope — pattern determined entirely by conditions" };
  }

  return { pattern: "unknown", confidence: "low", evidence: `principal op '${principalOp}' not recognized` };
}

/** Cedar patterns summary — for use in sampling prompts. */
export const CEDAR_PATTERNS_SUMMARY = `
Cedar supports three primary design patterns (official docs):

1. MEMBERSHIP (RBAC): principal in Role::"group" — permissions follow group membership.
   Example: permit(principal in Role::"editor", action in [...], resource);

2. RELATIONSHIP (ReBAC): principal in resource.owners — permissions follow resource relationships.
   Example: permit(principal is User, action in [...], resource is Doc) when { principal in resource.owners };

3. DISCRETIONARY: principal == Service::"specific" — ad-hoc per-entity grants.
   Example: permit(principal == Service::"Service-123", action == Action::"call", resource == Service::"Target");

All three can coexist in a policy store. Individual policies should follow one pattern.
`.trim();
