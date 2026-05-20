import { resolveStoreRef, buildStoreContext, formatContextForPrompt } from "./advise/context-builder.js";
import { selectGotchas } from "./advise/gotchas.js";
import { CEDAR_PATTERNS_SUMMARY } from "./advise/cedar-patterns.js";
import { AVP_RULES_SUMMARY } from "./advise/avp-rules.js";
import { storeManager, StoreManager } from "../resources/store-manager.js";

export type Sampler = (userPrompt: string, systemPrompt: string) => Promise<string>;

export interface AdviseInput {
  intent: string;
  store_ref?: string;
  previous_plan?: unknown;
  format_preference?: "structured" | "narrative";
}

export interface AdviseChange {
  step: number;
  type: string;
  description: string;
  rationale?: string;
  cedar_snippet?: string;
  cedar_snippet_before?: string;
  cedar_snippet_after?: string;
  avp_update_mode?: string;
  avp_consideration?: string;
  policy_id?: string;
}

export interface AdviseGotcha {
  id: string;
  severity: string;
  description: string;
  avp_error_category?: string;
}

export interface AdviseResult {
  intent_interpretation?: string;
  applicable_cedar_pattern?: string;
  affected_entities?: {
    principal_type?: string;
    action_ids?: string[];
    resource_type?: string;
  };
  required_changes?: AdviseChange[];
  gotchas?: AdviseGotcha[];
  verification_next_steps?: string;
  delta_from_previous?: boolean;
  unchanged_steps?: number[];
  modified_steps?: unknown[];
  added_steps?: unknown[];
  removed_steps?: unknown[];
  error?: string;
  raw_response?: string;
}

const SYSTEM_PROMPT = `You are a senior Cedar policy developer and AWS Verified Permissions expert. Your role is to help developers design Cedar policy changes safely. You have deep knowledge of Cedar policy patterns (Membership/RBAC, Relationship/ReBAC, Discretionary), the Cedar language gotchas, and the AWS Verified Permissions API constraints (especially UpdatePolicy immutability rules).

Always respond with a single valid JSON object matching the requested schema. Do not include any text, markdown, or prose outside the JSON object. The JSON must be parseable by JSON.parse().`;

const FULL_OUTPUT_SCHEMA = `Respond with exactly this JSON structure (omit optional fields if not applicable):
{
  "intent_interpretation": "one sentence re-statement of the intent in Cedar terms",
  "applicable_cedar_pattern": "Membership|Relationship|Discretionary|hybrid description",
  "affected_entities": {
    "principal_type": "Namespace::EntityType",
    "action_ids": ["ACTION_NAME"],
    "resource_type": "Namespace::EntityType"
  },
  "required_changes": [
    {
      "step": 1,
      "type": "schema|policy_new|policy_modify|policy_delete",
      "description": "what changes",
      "rationale": "why this change, why this sequence",
      "cedar_snippet": "Cedar text for schema or policy_new",
      "cedar_snippet_before": "existing Cedar text for policy_modify",
      "cedar_snippet_after": "updated Cedar text for policy_modify",
      "avp_update_mode": "in_place_via_update_policy|requires_delete_recreate|new_policy_via_create_policy",
      "avp_consideration": "AVP deployment note if relevant",
      "policy_id": "policy file id for policy_modify or policy_delete"
    }
  ],
  "gotchas": [
    {
      "id": "gotcha_id",
      "severity": "high|medium|info",
      "description": "what to watch out for",
      "avp_error_category": "AVP error category if applicable"
    }
  ],
  "verification_next_steps": "how to verify the plan was applied correctly"
}`;

const DELTA_OUTPUT_SCHEMA = `Respond with exactly this JSON structure:
{
  "delta_from_previous": true,
  "unchanged_steps": [1, 2],
  "modified_steps": [
    { "step": 3, "before": { "step contents from previous plan" }, "after": { "updated step contents" }, "reason": "what changed and why" }
  ],
  "added_steps": [{ "new step objects" }],
  "removed_steps": [{ "removed step objects" }],
  "intent_interpretation": "updated interpretation covering both old and new intent",
  "applicable_cedar_pattern": "pattern",
  "affected_entities": { "principal_type": "...", "action_ids": ["..."], "resource_type": "..." },
  "required_changes": ["FULL updated list of all steps in final order"],
  "gotchas": ["all relevant gotchas for the combined plan"],
  "verification_next_steps": "..."
}`;

export async function handleAdvise(
  input: AdviseInput,
  sampler: Sampler,
  manager: StoreManager = storeManager
): Promise<AdviseResult> {
  const storeContextSection = resolveStoreContext(input.store_ref, manager);
  const gotchaSection = buildGotchaSection(input.intent);
  const userPrompt = buildUserPrompt(input, storeContextSection, gotchaSection);
  const raw = await sampler(userPrompt, SYSTEM_PROMPT);
  return parseAdviseResponse(raw);
}

function resolveStoreContext(storeRef: string | undefined, manager: StoreManager): string {
  if (!storeRef) {
    return "No policy store provided — produce a generic plan based on the intent alone.";
  }
  const storeName = resolveStoreRef(storeRef);
  const ctx = buildStoreContext(storeName, manager);
  if (!ctx) {
    return `Store "${storeName}" not found or has no content — produce a generic plan.`;
  }
  return formatContextForPrompt(ctx);
}

function buildGotchaSection(intent: string): string {
  const selected = selectGotchas(intent);
  if (selected.length === 0) {
    return "No specific gotchas pre-selected — apply general Cedar safety rules.";
  }
  return selected
    .map(g => `[${g.severity.toUpperCase()}] ${g.id}: ${g.description}`)
    .join("\n\n");
}

function buildUserPrompt(input: AdviseInput, storeContextSection: string, gotchaSection: string): string {
  const isDelta = input.previous_plan != null;
  const outputSchema = isDelta ? DELTA_OUTPUT_SCHEMA : FULL_OUTPUT_SCHEMA;
  const task = isDelta
    ? `The user has already received a plan (shown in "Previous Plan" below). Their new intent refines or extends that plan. Produce ONLY the delta: which steps are unchanged, which are modified, which are added, and which are removed. Also include the full updated required_changes list for convenience.`
    : `Produce a complete Cedar policy change plan for the user's intent. Sequence schema changes before policy changes that reference new attributes. Classify each change's AVP update mode (in_place_via_update_policy, requires_delete_recreate, or new_policy_via_create_policy).`;

  const sections: string[] = [
    `## Cedar Policy Patterns Reference\n${CEDAR_PATTERNS_SUMMARY}`,
    `## AVP UpdatePolicy API Rules\n${AVP_RULES_SUMMARY}`,
    `## Pre-Selected Gotchas for This Request\n${gotchaSection}`,
    `## Current Policy Store Context\n${storeContextSection}`,
  ];

  if (isDelta) {
    sections.push(`## Previous Plan\n${JSON.stringify(input.previous_plan, null, 2)}`);
  }

  sections.push(`## User Intent\n${input.intent}`);
  sections.push(`## Task\n${task}`);
  sections.push(`## Required Output Schema\n${outputSchema}`);

  return sections.join("\n\n");
}

function parseAdviseResponse(raw: string): AdviseResult {
  let json = raw.trim();

  // Strip markdown code blocks
  const codeBlockMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    json = codeBlockMatch[1]!.trim();
  }

  try {
    return JSON.parse(json) as AdviseResult;
  } catch {
    // Try to find a JSON object anywhere in the response
    const objectMatch = json.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]) as AdviseResult;
      } catch {
        // fall through
      }
    }
    return {
      error: "Failed to parse LLM response as JSON",
      raw_response: raw,
    };
  }
}
