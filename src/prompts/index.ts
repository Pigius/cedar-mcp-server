/**
 * MCP Prompt definitions for cedar-mcp-server.
 *
 * Registration in src/server.ts:
 *   import { PROMPT_DEFINITIONS } from "./prompts/index.js";
 *   for (const p of PROMPT_DEFINITIONS) {
 *     server.prompt(p.name, p.description, p.argsSchema, p.handler);
 *   }
 *
 * Each PromptDefinition is built via definePrompt(), which captures the Zod
 * raw shape generically so TypeScript preserves the concrete arg types through
 * the handler. The array is typed as PromptDefinition<ZodRawShape> for the
 * export; the SDK's server.prompt() overload accepts the same shape.
 */

import { z } from "zod";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";

type ZodRawShape = Record<string, z.ZodTypeAny>;
type ShapeOutput<S extends ZodRawShape> = { [K in keyof S]: z.infer<S[K]> };
type PromptExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * PromptDefinition is intentionally generic so handler arg types are preserved
 * internally. At the export boundary the array is cast to the widened union
 * via definePrompt() which uses `as unknown as` once, in one place.
 */
export interface PromptDefinition<Args extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  argsSchema: Args;
  handler: (args: ShapeOutput<Args>, extra: PromptExtra) => GetPromptResult | Promise<GetPromptResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPromptDefinition = PromptDefinition<any>;

function definePrompt<Args extends ZodRawShape>(
  def: PromptDefinition<Args>
): AnyPromptDefinition {
  return def as AnyPromptDefinition;
}

// ---------------------------------------------------------------------------
// 1. cedar-review-policy-diff
//
// UX assumption: the user has two named policy stores ("blue" = production,
// "green" = candidate) and wants a structured review before promoting. They
// expect the prompt to drive all Cedar tool calls and produce a clear verdict.
//
// Falsifiability check: would this be useless? Yes, if it skipped the schema
// diff step. A promoter who misses schema diff will hit breaking changes only
// at query time. Fixed: schema diff is an explicit step with BREAKING/
// NON-BREAKING classification.
// ---------------------------------------------------------------------------
const reviewPolicyDiff = definePrompt({
  name: "cedar-review-policy-diff",
  description:
    "Drive a structured Cedar policy store promotion review: diff policies, diff schema, summarize breaking risk, and produce a go/no-go recommendation.",
  argsSchema: {
    blue_store: z.string().describe("Name of the baseline (production) policy store"),
    green_store: z.string().describe("Name of the candidate policy store to review"),
    focus: z
      .string()
      .optional()
      .describe(
        "Optional: narrows review attention, e.g. 'AVP immutability' or 'forbid rules only'"
      ),
  },
  handler: (args) => {
    const focusNote = args.focus
      ? `\n\nFocus area for this review: ${args.focus}. Apply extra scrutiny to anything touching that area.`
      : "";

    const text =
      `You are reviewing a Cedar policy store promotion from "${args.blue_store}" (baseline) to "${args.green_store}" (candidate).` +
      `${focusNote}` +
      `\n\nWork through the following steps in order.\n\n` +
      `Step 1: Structural diff.\n` +
      `Call cedar_diff_policy_stores with blue="${args.blue_store}" and green="${args.green_store}". ` +
      `List every added, removed, and modified policy. Note the policy IDs and whether each change is additive or restrictive.\n\n` +
      `Step 2: Schema diff.\n` +
      `Call cedar_diff_schema with schemas from both stores (cedar://schema/${args.blue_store} and cedar://schema/${args.green_store}). ` +
      `If the diff is non-trivial (any entity type added, removed, or attribute changed), classify each change as BREAKING or NON-BREAKING. ` +
      `A schema change is BREAKING if existing valid Cedar requests could become invalid or if attribute types narrow.\n\n` +
      `Step 3: Behavioral drift summary.\n` +
      `If behavioral_test_requests are available in either store, note any decisions that differ between blue and green. ` +
      `Flag any new Deny decisions that did not exist in blue as HIGH risk.\n\n` +
      `Step 4: Recommendation.\n` +
      `Produce a plain-English summary covering: (a) structural changes, (b) breaking schema risk items, ` +
      `(c) behavioral drift if present, and (d) a clear PROMOTE / DO NOT PROMOTE / PROMOTE WITH CAUTION verdict with reasoning. ` +
      `No marketing language. Use semicolons instead of dashes for lists. Be specific about which policy IDs drive the verdict.`;

    return {
      messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
    };
  },
});

// ---------------------------------------------------------------------------
// 2. cedar-explain-denial
//
// UX assumption: a developer got an unexpected Deny (or Allow) and wants a
// plain-English explanation without needing to know which tools to call or
// in what order.
// ---------------------------------------------------------------------------
const explainDenial = definePrompt({
  name: "cedar-explain-denial",
  description:
    "Explain why a Cedar authorization request was allowed or denied, in plain English, by evaluating the request and examining the deciding policies.",
  argsSchema: {
    principal: z.string().describe('Principal entity reference, e.g. MyApp::User::"alice"'),
    action: z.string().describe('Action entity reference, e.g. MyApp::Action::"read"'),
    resource: z.string().describe('Resource entity reference, e.g. MyApp::Document::"doc-1"'),
    store: z.string().describe("Name of the policy store to evaluate against"),
  },
  handler: (args) => {
    const text =
      `Explain why the following Cedar authorization request was decided the way it was.\n\n` +
      `Principal: ${args.principal}\n` +
      `Action:    ${args.action}\n` +
      `Resource:  ${args.resource}\n` +
      `Store:     ${args.store}\n\n` +
      `Work through the following steps.\n\n` +
      `Step 1: Evaluate.\n` +
      `Call cedar_authorize with:\n` +
      `  policy_ref  = "cedar://policies/${args.store}"\n` +
      `  schema_ref  = "cedar://schema/${args.store}"\n` +
      `  principal   = "${args.principal}"\n` +
      `  action      = "${args.action}"\n` +
      `  resource    = "${args.resource}"\n` +
      `  entities    = load from "cedar://entities/${args.store}" if available, otherwise use []\n\n` +
      `Step 2: Explain deciding policies.\n` +
      `Take the policy IDs returned in determining_policies from Step 1. ` +
      `Call cedar_explain on those policy IDs so you have the human-readable logic for each one.\n\n` +
      `Step 3: Plain-English explanation.\n` +
      `Write a clear explanation covering:\n` +
      `  (a) The decision (Allow or Deny) and which policy or policies drove it.\n` +
      `  (b) Why this principal, action, and resource matched or did not match each determining policy.\n` +
      `  (c) What would need to change for the opposite decision: either a policy edit, an entity attribute change, or a context value.\n\n` +
      `Keep the explanation factual and specific. Avoid jargon beyond standard Cedar terms (permit, forbid, principal, action, resource, context).`;

    return {
      messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
    };
  },
});

// ---------------------------------------------------------------------------
// 3. cedar-avp-migration-checklist
//
// UX assumption: the user is preparing to move a local Cedar policy set into
// Amazon Verified Permissions and wants a guided checklist to avoid easy-to-miss
// steps (schema format, single-namespace constraint, entity validation).
// This is purely informational; no tool calls are issued inside the prompt body.
//
// Design for "no required args": namespace is optional. When supplied it is
// substituted into the checklist where AVP requires a single namespace. When
// omitted a placeholder is used so the checklist is still complete and actionable.
// ---------------------------------------------------------------------------
const avpMigrationChecklist = definePrompt({
  name: "cedar-avp-migration-checklist",
  description:
    "Provide a guided checklist for migrating a local Cedar policy set into Amazon Verified Permissions, covering schema format, namespace constraints, entity validation, and behavioral diff.",
  argsSchema: {
    namespace: z
      .string()
      .optional()
      .describe(
        "Optional: the single Cedar namespace your AVP policy store will use, e.g. MyApp"
      ),
  },
  handler: (args) => {
    const ns = args.namespace ?? "<YourNamespace>";

    const text =
      `AVP migration checklist for namespace: ${ns}\n\n` +
      `Work through each item before moving policies or schema into Amazon Verified Permissions.\n\n` +
      `1. Schema format detection.\n` +
      `Call cedar_validate_schema on your existing schema file. Note whether it is in Cedar JSON format or .cedarschema (human-readable) format. ` +
      `AVP accepts both, but they have different upload paths. Confirm which format you have before proceeding.\n\n` +
      `2. Single-namespace constraint.\n` +
      `AVP enforces a single namespace per policy store. All entity types, actions, and attributes must live under "${ns}". ` +
      `If your local Cedar schema uses multiple namespaces, flatten them now. cedar_validate_schema will surface any namespace collisions.\n\n` +
      `3. Entity format auto-detection.\n` +
      `Cedar WASM accepts a relaxed entity format; AVP is stricter. Run cedar_validate_entities against your entity set with the schema attached. ` +
      `Fix any entities missing required attributes or using incorrect UID formats before upload.\n\n` +
      `4. Template-linked policies.\n` +
      `If you use policy templates, call cedar_link_template for each template-principal-resource combination to confirm links are valid. ` +
      `AVP supports template-linked policies but each link must reference a template that already exists in the store.\n\n` +
      `5. Schema diff before PutSchema.\n` +
      `If you are updating an existing AVP store schema (not a fresh store), call cedar_diff_schema between your local schema and the current AVP schema. ` +
      `Classify every change as BREAKING or NON-BREAKING before calling PutSchema. ` +
      `AVP does not roll back schema changes automatically; a BREAKING change can silently invalidate existing policies.\n\n` +
      `6. Behavioral diff before traffic shift.\n` +
      `After loading policies into the AVP store, use cedar_diff_policy_stores to compare local (blue) with AVP (green). ` +
      `Run any behavioral test cases you have. Confirm no new Deny decisions appear for requests that should be allowed. ` +
      `Only shift production traffic after this step passes.\n\n` +
      `All steps must pass before tagging the migration as complete.`;

    return {
      messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
    };
  },
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const PROMPT_DEFINITIONS: AnyPromptDefinition[] = [
  reviewPolicyDiff,
  explainDenial,
  avpMigrationChecklist,
];
