import { policyToJson, templateToJson } from "@cedar-policy/cedar-wasm/nodejs";
import {
  describePrincipal,
  describeAction,
  describeResource,
  describeCondition,
  detectPatterns,
} from "../parser/policy-ast.js";
import type { PolicyJson } from "@cedar-policy/cedar-wasm/nodejs";

export interface ExplainInput {
  policy: string;
  schema?: string;
}

export interface ScopeDescription {
  scope: string;
  description: string;
}

export interface ConditionDescription {
  kind: "when" | "unless";
  text: string;
}

export interface ExplainResult {
  effect: "permit" | "forbid";
  principal: ScopeDescription;
  action: ScopeDescription;
  resource: ScopeDescription;
  conditions: ConditionDescription[];
  summary: string;
  patterns_detected: string[];
  error?: string;
}

function parsePolicyJson(policyText: string): PolicyJson {
  const result = policyToJson(policyText);
  if (result.type === "success") return result.json;

  const errors = result.errors.map((e) => e.message).join("; ");

  // Fall back to templateToJson if the error is about template slots
  if (errors.includes("template") || errors.includes("slot")) {
    const templateResult = templateToJson(policyText);
    if (templateResult.type === "success") return templateResult.json as unknown as PolicyJson;
    throw new Error(templateResult.errors.map((e) => e.message).join("; "));
  }

  throw new Error(errors);
}

function buildSummary(
  json: PolicyJson,
  principalDesc: string,
  actionDesc: string,
  resourceDesc: string,
  conditions: ConditionDescription[],
  isTemplate: boolean
): string {
  const effect = json.effect === "permit" ? "PERMITS" : "FORBIDS";
  const base = `${effect} ${principalDesc} to perform ${actionDesc} on ${resourceDesc}`;

  if (isTemplate) {
    const slots = [
      json.principal.op === "==" && "slot" in json.principal ? `?principal` : null,
      json.resource.op === "==" && "slot" in json.resource ? `?resource` : null,
    ].filter(Boolean);
    return `TEMPLATE POLICY: ${base}. Template slots: ${slots.join(", ")}.`;
  }

  if (conditions.length === 0) return `${base}.`;

  const whenClauses = conditions
    .filter((c) => c.kind === "when")
    .map((c) => c.text.replace(/^WHEN /, ""));
  const unlessClauses = conditions
    .filter((c) => c.kind === "unless")
    .map((c) => c.text.replace(/^UNLESS /, ""));

  let summary = base;
  if (whenClauses.length > 0) summary += `, when: ${whenClauses.join("; ")}`;
  if (unlessClauses.length > 0) summary += `, unless: ${unlessClauses.join("; ")}`;
  return summary + ".";
}

export async function handleExplain(input: ExplainInput): Promise<ExplainResult> {
  let json: PolicyJson;
  let isTemplate = false;

  try {
    const raw = policyToJson(input.policy);
    if (raw.type === "failure") {
      const errors = raw.errors.map((e) => e.message).join("; ");
      if (errors.includes("template") || errors.includes("slot")) {
        const templateResult = templateToJson(input.policy);
        if (templateResult.type === "failure") {
          return {
            effect: "permit",
            principal: { scope: "unknown", description: "unknown" },
            action: { scope: "unknown", description: "unknown" },
            resource: { scope: "unknown", description: "unknown" },
            conditions: [],
            summary: "Failed to parse policy.",
            patterns_detected: [],
            error: templateResult.errors.map((e) => e.message).join("; "),
          };
        }
        json = templateResult.json as unknown as PolicyJson;
        isTemplate = true;
      } else {
        return {
          effect: "permit",
          principal: { scope: "unknown", description: "unknown" },
          action: { scope: "unknown", description: "unknown" },
          resource: { scope: "unknown", description: "unknown" },
          conditions: [],
          summary: "Failed to parse policy.",
          patterns_detected: [],
          error: errors,
        };
      }
    } else {
      json = raw.json;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      effect: "permit",
      principal: { scope: "unknown", description: "unknown" },
      action: { scope: "unknown", description: "unknown" },
      resource: { scope: "unknown", description: "unknown" },
      conditions: [],
      summary: "Failed to parse policy.",
      patterns_detected: [],
      error: msg,
    };
  }

  const principalDesc = describePrincipal(json.principal);
  const actionDesc = describeAction(json.action);
  const resourceDesc = describeResource(json.resource);

  const conditions: ConditionDescription[] = json.conditions.map((c) => ({
    kind: c.kind,
    text: describeCondition(c),
  }));

  const patterns = detectPatterns(json);
  if (isTemplate && !patterns.includes("template_policy")) patterns.unshift("template_policy");

  const summary = buildSummary(json, principalDesc, actionDesc, resourceDesc, conditions, isTemplate);

  return {
    effect: json.effect,
    principal: { scope: json.principal.op, description: principalDesc },
    action: { scope: json.action.op, description: actionDesc },
    resource: { scope: json.resource.op, description: resourceDesc },
    conditions,
    summary,
    patterns_detected: patterns,
  };
}
