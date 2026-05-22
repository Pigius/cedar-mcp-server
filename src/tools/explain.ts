import { policyToJson, templateToJson, policySetTextToParts } from "@cedar-policy/cedar-wasm/nodejs";
import {
  describePrincipal,
  describeAction,
  describeResource,
  describeCondition,
  detectPatterns,
} from "../parser/policy-ast.js";
import type { PolicyJson } from "@cedar-policy/cedar-wasm/nodejs";
import { storeManager } from "../resources/store-manager.js";

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
  /**
   * 10d workspace auto-discovery: populated by the server.ts MCP handler when
   * the schema was resolved from a loaded MCP root rather than supplied inline.
   * On ExplainManyResult the field appears on the top-level result so a single
   * auto-discovery decision applies to the whole policy set.
   */
  auto_discovered?: {
    schema_from?: string;
  };
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

// ─── Multi-policy entry point ──────────────────────────────────────────────────

export interface ExplainManyResult {
  policy_count: number;
  policies: Array<ExplainResult & { index: number }>;
  /**
   * 10d workspace auto-discovery: see ExplainResult.auto_discovered. On the
   * many-result the field lives at the top level so the auto-discovered schema
   * is reported once rather than duplicated on every policy entry.
   */
  auto_discovered?: {
    schema_from?: string;
  };
}

/**
 * Explains a Cedar policy set (one or more policies).
 * Uses policySetTextToParts to split, then explains each individually.
 * Falls back to single-policy handling when there is exactly one policy.
 */
export async function handleExplainMany(input: ExplainInput): Promise<ExplainManyResult | ExplainResult> {
  const parts = policySetTextToParts(input.policy);

  // Single policy or unparseable — fall through to single-policy handler
  if (parts.type === "failure" || (parts.policies.length + parts.policy_templates.length) <= 1) {
    return handleExplain(input);
  }

  const allPolicies = [...parts.policies, ...parts.policy_templates];
  const results = await Promise.all(
    allPolicies.map(async (policyText, i) => {
      const result = await handleExplain({ policy: policyText, schema: input.schema });
      return { ...result, index: i };
    })
  );

  return {
    policy_count: allPolicies.length,
    policies: results,
  };
}

// ─── 10d workspace auto-discovery wrapper ────────────────────────────────────

/**
 * Inputs accepted by the MCP-level explain entry point. Wider than
 * `ExplainInput` because it also accepts the `_ref` shape the MCP layer
 * resolves before reaching `handleExplainMany`.
 */
export interface ExplainMcpInput {
  policy: string;
  schema?: string;
  schema_ref?: string;
  store?: string;
}

/**
 * 10d workspace auto-discovery wrapper for `cedar_explain`. Resolves the
 * schema from a loaded MCP root when neither `schema` nor `schema_ref` was
 * supplied. The schema is optional for explain, so single-store deployments
 * with no schema file just delegate to the parser without one. Multi-store
 * deployments with no explicit `store` parameter return an ambiguity error.
 */
export async function handleExplainMcp(
  input: ExplainMcpInput,
  resolveRef: (uri: string) => { content: string } | { error: string },
): Promise<{ result: ExplainResult | ExplainManyResult } | { error: string }> {
  let schema = input.schema;
  if (!schema && input.schema_ref) {
    const resolved = resolveRef(input.schema_ref);
    if ("error" in resolved) return { error: resolved.error };
    schema = resolved.content;
  }

  let autoSchemaFrom: string | undefined;
  if (!schema && !input.schema_ref) {
    if (input.store) {
      try {
        schema = storeManager.readSchema(input.store);
        autoSchemaFrom = input.store;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      const def = storeManager.getDefaultStore();
      if (def.kind === "single") {
        try {
          schema = storeManager.readSchema(def.store.name);
          autoSchemaFrom = def.store.name;
        } catch {
          // Store has no schema file; explain runs without a schema.
        }
      } else if (def.kind === "ambiguous") {
        return { error: `Multiple stores are loaded (${def.names.join(", ")}). Pass store: "<name>" to choose.` };
      }
    }
  }

  const result = await handleExplainMany({ policy: input.policy, schema });
  if (autoSchemaFrom) {
    result.auto_discovered = { schema_from: autoSchemaFrom };
  }
  return { result };
}
