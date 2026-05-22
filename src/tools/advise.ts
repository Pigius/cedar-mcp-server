/**
 * cedar_advise — Cedar policy change planning context preparator.
 *
 * This tool returns deterministic, structured context for the calling LLM to
 * produce a Cedar policy change plan natively. No MCP sampling, no client LLM
 * round-trip. The bundle encodes Cedar/AVP knowledge that does not live in the
 * policy files themselves (pattern classification, AVP UpdatePolicy mutability
 * rules, intent-selected gotchas, sequencing rules) and is what makes the
 * server load-bearing rather than substitutable by Read.
 *
 * Design v2, 2026-05-21: pivoted from sampling-based planner. See
 * projects/cedar-mcp-server/02-technical-design.md "design v2".
 */

import { checkParseSchema, schemaToJsonWithResolvedTypes } from "@cedar-policy/cedar-wasm/nodejs";
import type { Schema } from "@cedar-policy/cedar-wasm/nodejs";
import { resolveStoreRef, buildStoreContext } from "./advise/context-builder.js";
import type { PolicyInventoryEntry } from "./advise/context-builder.js";
import { selectGotchas, type Gotcha } from "./advise/gotchas.js";
import { CEDAR_PATTERNS_SUMMARY } from "./advise/cedar-patterns.js";
import { AVP_RULES_SUMMARY, AVP_VALIDATION_ERRORS } from "./advise/avp-rules.js";
import { storeManager, StoreManager } from "../resources/store-manager.js";

export interface AdviseInput {
  intent: string;
  store_ref?: string;
}

export interface AdviseGotcha {
  id: string;
  severity: "high" | "medium" | "info";
  description: string;
  avp_error_category?: string;
}

export interface SchemaSummary {
  valid: boolean;
  format: "json" | "cedarschema";
  namespaces: string[];
  entity_type_count: number;
  action_count: number;
  raw_text: string;
  errors?: string[];
}

export interface PatternDetected {
  pattern: string;
  count: number;
}

export interface CedarPatternDescription {
  name: string;
  description: string;
  example: string;
}

export interface AvpUpdatePolicyRules {
  summary: string;
  in_place_via_update_policy: string[];
  requires_delete_recreate: string[];
  new_via_create_policy: string[];
  notes: string[];
}

export interface AdviseContextBundle {
  tool: "cedar_advise";
  bundle_version: "v2";
  intent: string;
  store_name?: string;
  store_status: "loaded" | "not_provided" | "not_found" | "ambiguous";
  /**
   * Names of every currently loaded store, populated when the resolver could
   * not commit to a single store: `not_found` (caller named an unknown store)
   * and `ambiguous` (no `store_ref` passed but multiple stores are loaded).
   * Lets the calling LLM recover by retrying with an explicit `store_ref`
   * without making another tool call just to learn the candidate names.
   */
  available_stores?: string[];
  /**
   * Populated when the resolver inferred the store rather than honoring an
   * explicit `store_ref`. Currently the only resolution path is
   * `single_loaded_store` (no `store_ref`, exactly one store loaded).
   */
  auto_discovered?: { store_from: "single_loaded_store" };
  schema_summary?: SchemaSummary;
  policy_inventory: PolicyInventoryEntry[];
  patterns_detected_in_store: PatternDetected[];
  applicable_gotchas: AdviseGotcha[];
  avp_update_policy_rules: AvpUpdatePolicyRules;
  avp_validation_error_catalog: { id: string; description: string }[];
  cedar_patterns_reference: {
    summary: string;
    patterns: CedarPatternDescription[];
  };
  sequencing_guidance: string[];
  next_steps_for_llm: string;
}

const SEQUENCING_GUIDANCE: string[] = [
  "Schema changes that add new entity types, attributes, or actions MUST be deployed BEFORE policies that reference them. AVP validates each policy against the current schema at CreatePolicy/UpdatePolicy time.",
  "Removing an entity type, action, or required attribute is BREAKING for any policy that references it. Update or delete dependent policies first, then remove the schema element.",
  "Changing a required attribute to optional is safe; changing an optional attribute to required can silently skip policies that previously matched (Cedar drops policies that touch a missing required attribute via UnsafeOptionalAttributeAccess).",
  "For renames (entity type, action id, attribute name), there is no atomic rename in AVP. Plan as: add the new name + dual-write policies, migrate consumers, then remove the old name.",
];

const AVP_UPDATE_POLICY_RULES: AvpUpdatePolicyRules = {
  summary: AVP_RULES_SUMMARY,
  in_place_via_update_policy: [
    "Action scope (action == ... or action in [...])",
    "When/unless condition clauses",
    "Policy name / description metadata",
  ],
  requires_delete_recreate: [
    "Effect (permit ↔ forbid)",
    "Principal scope (head clause)",
    "Resource scope (head clause)",
    "Conversion between static and template-linked policy",
  ],
  new_via_create_policy: [
    "Wholly new policy added to the store (no in-place path applies)",
  ],
  notes: [
    "UpdatePolicy only updates STATIC policies. Template-linked policies use UpdatePolicyTemplate (or relink).",
    "AVP error code for an attempted illegal change is ConflictException / ResourceNotFoundException depending on whether the policy still resolves under the new shape.",
  ],
};

const CEDAR_PATTERNS_DETAIL: CedarPatternDescription[] = [
  {
    name: "Membership (RBAC)",
    description: "Principal head clause uses `in Role::\"…\"` or similar group/role parent. Permissions follow group membership.",
    example: 'permit (principal in App::Role::"editor", action in [App::Action::"read"], resource);',
  },
  {
    name: "Relationship (ReBAC)",
    description: "Conditions reference principal's relationship to the resource (often via an attribute on resource like `owners`, `viewers`, `team`).",
    example: 'permit (principal is App::User, action in [App::Action::"read"], resource is App::Doc) when { principal in resource.owners };',
  },
  {
    name: "Discretionary",
    description: "Principal head clause uses `==` to grant access to a specific named entity (no group, no relationship — ad hoc).",
    example: 'permit (principal == App::Service::"ingest", action == App::Action::"write", resource == App::Bucket::"raw");',
  },
  {
    name: "Hybrid",
    description: "Policy combines membership in the head clause with a relationship or ABAC predicate in the condition body. Common in production stores.",
    example: 'permit (principal in App::Role::"editor", action in [App::Action::"write"], resource) when { principal in resource.team };',
  },
];

const NEXT_STEPS_FOR_LLM = `Use this context to produce a Cedar policy change plan. Do not skip these steps:

1. Identify the entity types, attributes, and actions in schema_summary that the user's intent touches. If schema_summary is absent (store_status != "loaded"), state the assumption you are making about the schema and ask the user to confirm. If store_status is "ambiguous", do NOT pick a store silently; ask the user which one from available_stores and re-invoke cedar_advise with an explicit store_ref. If store_status is "not_found" and available_stores is populated, the caller probably mistyped the store name; re-invoke with the corrected name from available_stores. If policy_inventory is empty even though the store loaded, state that the store has no policies yet and confirm with the user before proposing anything other than initial-state policies.
2. Pick the most appropriate cedar_patterns_reference pattern for the change. If the store already uses a dominant pattern (see patterns_detected_in_store), prefer it for consistency unless the intent requires otherwise.
3. Sequence steps per sequencing_guidance. Schema changes that add a referenced attribute MUST precede policy changes that read it.
4. For each step that modifies an existing policy, classify it against avp_update_policy_rules. Effect / principal / resource changes require delete-and-recreate; action and when/unless changes are in-place.
5. Address every applicable_gotcha in the plan (either by structuring the snippet to avoid it, or by surfacing it as a warning to the user).
6. After drafting Cedar snippets, call cedar_validate on each to confirm syntax + schema-typing before recommending them. Reading a snippet does not tell you whether the Cedar parser accepts it.
7. For each modification to an existing policy, call cedar_check_policy_change with the old and new text to confirm the AVP UpdatePolicy classification you assigned.
8. If the change spans two stores (current vs. proposed), call cedar_diff_policy_stores to check for behavioral drift before recommending deployment.`;

/**
 * Build the cedar_advise context bundle.
 *
 * Pure function — no sampler, no LLM round-trip. The calling MCP client's
 * conversation LLM is expected to interpret this bundle and produce the plan.
 */
export function handleAdvise(
  input: AdviseInput,
  manager: StoreManager = storeManager
): AdviseContextBundle {
  const gotchas = selectGotchas(input.intent).map(gotchaToAdvise);
  const storeView = resolveStoreView(input.store_ref, manager);

  const bundle: AdviseContextBundle = {
    tool: "cedar_advise",
    bundle_version: "v2",
    intent: input.intent,
    store_name: storeView.store_name,
    store_status: storeView.store_status,
    schema_summary: storeView.schema_summary,
    policy_inventory: storeView.policy_inventory,
    patterns_detected_in_store: storeView.patterns_detected,
    applicable_gotchas: gotchas,
    avp_update_policy_rules: AVP_UPDATE_POLICY_RULES,
    avp_validation_error_catalog: AVP_VALIDATION_ERRORS.map(e => ({ id: e.id, description: e.description })),
    cedar_patterns_reference: {
      summary: CEDAR_PATTERNS_SUMMARY,
      patterns: CEDAR_PATTERNS_DETAIL,
    },
    sequencing_guidance: SEQUENCING_GUIDANCE,
    next_steps_for_llm: NEXT_STEPS_FOR_LLM,
  };
  if (storeView.available_stores) bundle.available_stores = storeView.available_stores;
  if (storeView.auto_discovered) bundle.auto_discovered = storeView.auto_discovered;
  return bundle;
}

interface StoreView {
  store_name?: string;
  store_status: "loaded" | "not_provided" | "not_found" | "ambiguous";
  schema_summary?: SchemaSummary;
  policy_inventory: PolicyInventoryEntry[];
  patterns_detected: PatternDetected[];
  available_stores?: string[];
  auto_discovered?: { store_from: "single_loaded_store" };
}

function resolveStoreView(storeRef: string | undefined, manager: StoreManager): StoreView {
  if (!storeRef) {
    // Round 4 dogfood (Scenario A): with no store_ref, the calling LLM has no
    // way to learn what stores are loaded short of making a separate tool call
    // and reading `auto_discovered` off the response. Auto-resolve when the
    // resolution is unambiguous; surface candidate names otherwise so the
    // caller can retry with an explicit `store_ref`.
    const names = manager.listStoreNames();
    if (names.length === 0) {
      return { store_status: "not_provided", policy_inventory: [], patterns_detected: [] };
    }
    if (names.length === 1) {
      const onlyStoreName = names[0]!;
      const ctx = buildStoreContext(onlyStoreName, manager);
      if (!ctx) {
        // 11d audit finding: the single loaded store exists in StoreManager but
        // cannot be grounded (most often: workspace has policies/ but no
        // schema.cedarschema or schema.json, so `buildStoreContext` throws
        // inside readSchema and returns null). Returning `not_found` with the
        // candidate name is self-referential and triggers the next_steps_for_llm
        // "re-invoke with corrected name from available_stores" advice, which
        // loops. Degrade to `not_provided` instead: the bundle still carries
        // the universal Cedar/AVP context, and the LLM treats it as
        // store-less rather than as a typo'd ref.
        return { store_status: "not_provided", policy_inventory: [], patterns_detected: [] };
      }
      return {
        store_name: ctx.store_name,
        store_status: "loaded",
        schema_summary: summarizeSchema(ctx.schema_text),
        policy_inventory: ctx.policy_inventory,
        patterns_detected: countPatterns(ctx.policy_inventory),
        auto_discovered: { store_from: "single_loaded_store" },
      };
    }
    return {
      store_status: "ambiguous",
      policy_inventory: [],
      patterns_detected: [],
      available_stores: names,
    };
  }
  const storeName = resolveStoreRef(storeRef);
  const ctx = buildStoreContext(storeName, manager);
  if (!ctx) {
    const available = manager.listStoreNames();
    const view: StoreView = {
      store_name: storeName,
      store_status: "not_found",
      policy_inventory: [],
      patterns_detected: [],
    };
    if (available.length > 0) view.available_stores = available;
    return view;
  }
  return {
    store_name: ctx.store_name,
    store_status: "loaded",
    schema_summary: summarizeSchema(ctx.schema_text),
    policy_inventory: ctx.policy_inventory,
    patterns_detected: countPatterns(ctx.policy_inventory),
  };
}

function summarizeSchema(schemaText: string): SchemaSummary {
  const parsed = parseSchemaInput(schemaText);
  const answer = checkParseSchema(parsed.schema);
  if (answer.type === "failure") {
    return {
      valid: false,
      format: parsed.format,
      namespaces: [],
      entity_type_count: 0,
      action_count: 0,
      raw_text: schemaText,
      errors: answer.errors.map(e => e.message),
    };
  }

  if (parsed.format === "json") {
    const counts = summarizeJsonSchema(parsed.schema);
    return { valid: true, format: parsed.format, raw_text: schemaText, ...counts };
  }

  // For cedarschema text, translate to JSON form to derive structural counts.
  try {
    const jsonAnswer = schemaToJsonWithResolvedTypes(schemaText);
    if (jsonAnswer.type === "success") {
      const counts = summarizeJsonSchema(jsonAnswer.json);
      return { valid: true, format: parsed.format, raw_text: schemaText, ...counts };
    }
  } catch {
    // fall through to summary-less success
  }

  return {
    valid: true,
    format: parsed.format,
    namespaces: [],
    entity_type_count: 0,
    action_count: 0,
    raw_text: schemaText,
  };
}

function parseSchemaInput(schemaStr: string): { schema: Schema; format: "json" | "cedarschema" } {
  try {
    return { schema: JSON.parse(schemaStr), format: "json" };
  } catch {
    return { schema: schemaStr, format: "cedarschema" };
  }
}

interface JsonSchemaShape {
  [namespace: string]: {
    entityTypes?: Record<string, unknown>;
    actions?: Record<string, unknown>;
  };
}

function summarizeJsonSchema(json: unknown): {
  namespaces: string[];
  entity_type_count: number;
  action_count: number;
} {
  const empty = { namespaces: [], entity_type_count: 0, action_count: 0 };
  if (!json || typeof json !== "object") return empty;
  const shape = json as JsonSchemaShape;
  const namespaces = Object.keys(shape);
  let entity_type_count = 0;
  let action_count = 0;
  for (const ns of namespaces) {
    const block = shape[ns];
    if (block.entityTypes) entity_type_count += Object.keys(block.entityTypes).length;
    if (block.actions) action_count += Object.keys(block.actions).length;
  }
  return { namespaces, entity_type_count, action_count };
}

function countPatterns(inventory: PolicyInventoryEntry[]): PatternDetected[] {
  const counts = new Map<string, number>();
  for (const entry of inventory) {
    counts.set(entry.pattern, (counts.get(entry.pattern) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([pattern, count]) => ({ pattern, count }));
}

function gotchaToAdvise(g: Gotcha): AdviseGotcha {
  const advise: AdviseGotcha = {
    id: g.id,
    severity: g.severity,
    description: g.description,
  };
  if (g.avp_error_category) {
    advise.avp_error_category = g.avp_error_category;
  }
  return advise;
}
