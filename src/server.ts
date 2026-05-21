import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleAuthorize } from "./tools/authorize.js";
import { handleAuthorizeBatch } from "./tools/authorize-batch.js";
import { handleValidate } from "./tools/validate.js";
import { handleValidateSchema } from "./tools/validate-schema.js";
import { handleDiffSchema } from "./tools/diff-schema.js";
import { handleValidateEntities } from "./tools/validate-entities.js";
import { handleFormat } from "./tools/format.js";
import { handleTranslate } from "./tools/translate.js";
import { handleExplainMany } from "./tools/explain.js";
import { handleCheckChange } from "./tools/check-change.js";
import { handleGenerateSample } from "./tools/generate-sample.js";
import { handleDiffStores } from "./tools/diff-stores.js";
import { handleAdvise } from "./tools/advise.js";
import { handleValidateTemplate } from "./tools/validate-template.js";
import { handleLinkTemplate } from "./tools/link-template.js";
import { handleListTemplates } from "./tools/list-templates.js";
import { handleListTemplateLinks } from "./tools/list-template-links.js";
import { storeManager } from "./resources/store-manager.js";
import { resolveRef } from "./resources/ref-resolver.js";
import { PROMPT_DEFINITIONS } from "./prompts/index.js";

export const SERVER_NAME = "cedar-mcp-server";
export const SERVER_VERSION = "0.0.1";

/**
 * Server-level instructions returned in the MCP `initialize` response. Surfaced
 * by the client (Claude Code, Claude Desktop, Cursor) as a system-prompt hint
 * for when to reach for this server's tools. Truncated at 2KB in Claude Code,
 * so critical routing guidance is front-loaded.
 *
 * Added in response to the 2026-05-21 falsification test result: tool-level
 * descriptions alone (kickoff-08 sub-phase 8b) did not stop Claude from
 * bypassing the cedar_* tools via Read + Bash. See
 * projects/cedar-mcp-server/research-mcp-discoverability-patterns.md
 * "Path 0" for the rationale.
 */
export const SERVER_INSTRUCTIONS = `cedar-mcp-server provides Cedar policy language and AWS Verified Permissions tooling.

For ANY question about Cedar policies, schemas, entities, or authorization decisions, you MUST call the appropriate cedar_* tool rather than reading files and reasoning natively. The Cedar engine, AST parser, and AVP rules encoded in this server are the authoritative source; reading .cedar files alone is insufficient because pattern classification, policy evaluation, AVP UpdatePolicy mutability, and gotchas catalog cannot be reconstructed from file text.

Tool routing:
- "Plan a Cedar change" / "how do I add X rule" / "help me restrict Y" -> cedar_advise FIRST. Returns structured context bundle (gotchas, AVP rules, Cedar patterns, current policy classification). Reason from the bundle.
- "What does this policy do?" / "explain this Cedar" -> cedar_explain
- "Is this policy valid?" / "check my Cedar syntax" -> cedar_validate
- "Would X be allowed to do Y on Z?" / "test this authorization" -> cedar_authorize
- "Compare two policy stores" / "is it safe to deploy" -> cedar_diff_policy_stores
- "Why was X denied?" -> cedar_authorize then cedar_explain (positional policy IDs need explanation lookup)
- "Generate a test payload" -> cedar_generate_sample_request
- "Migrating from AVP" / "is my schema AVP-compatible" -> cedar_project_intelligence (when shipped) or cedar_validate_schema
- "Modify an existing policy" -> cedar_check_policy_change FIRST (returns AVP UpdatePolicy classification)

Do NOT use Read or Bash to inspect Cedar policy semantics. The server tools encode Cedar/AVP knowledge that does not live in the files.`;

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  }, {
    instructions: SERVER_INSTRUCTIONS,
  });

  server.tool(
    "cedar_authorize",
    "Evaluate a Cedar authorization request against policies and entities. Returns the decision (Allow/Deny), the determining policies, and any evaluation errors. ALWAYS call this for any 'would X be allowed?' or 'why was Y denied?' question. You CANNOT simulate an authorization decision by reading the policy files; only the Cedar engine implements the full evaluation semantics (default-deny, forbid-overrides-permit, attribute guards, action group membership, schema-validated entity types). Accepts inline policy text OR a cedar:// resource reference.",
    {
      policies: z.string().optional().describe("Cedar policy text (one or more policies). Omit if using policy_ref."),
      policy_ref: z.string().optional().describe("cedar:// URI to load policies from a configured store, e.g. cedar://policies/blue"),
      principal: z.string().describe('Principal entity reference, e.g. Namespace::Type::"id"'),
      action: z.string().describe('Action entity reference, e.g. Namespace::Action::"name"'),
      resource: z.string().describe('Resource entity reference, e.g. Namespace::Type::"id"'),
      entities: z.string().optional().describe("JSON array of entity objects with uid, attrs, and parents. Omit if using entities_ref."),
      entities_ref: z.string().optional().describe("cedar:// URI to load entities from a configured store, e.g. cedar://entities/production"),
      schema: z.string().optional().describe("Optional Cedar schema (JSON or .cedarschema format) — enables request validation"),
      schema_ref: z.string().optional().describe("cedar:// URI to load schema from a configured store, e.g. cedar://schema/blue"),
      context: z.string().optional().describe("Optional JSON object with context attributes"),
    },
    async (input) => {
      // Resolve policy_ref / schema_ref — inline values take precedence
      let policies = input.policies;
      if (!policies && input.policy_ref) {
        const resolved = resolveRef(input.policy_ref);
        if ("error" in resolved) return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }] };
        policies = resolved.content;
      }
      if (!policies) return { content: [{ type: "text", text: JSON.stringify({ error: "Either policies or policy_ref is required" }) }] };

      let schema = input.schema;
      if (!schema && input.schema_ref) {
        const resolved = resolveRef(input.schema_ref);
        if ("error" in resolved) return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }] };
        schema = resolved.content;
      }

      let entities = input.entities;
      if (!entities && input.entities_ref) {
        const resolved = resolveRef(input.entities_ref);
        if ("error" in resolved) return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }] };
        entities = resolved.content;
      }
      if (!entities) return { content: [{ type: "text", text: JSON.stringify({ error: "Either entities or entities_ref is required" }) }] };

      const result = await handleAuthorize({ ...input, policies, schema, entities });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "cedar_authorize_batch",
    "Run N authorization requests through ONE policy set in a single call and return the full decision matrix (Allow / Deny / Error per request, with determining policies). ALWAYS use this for regression testing after a policy edit, for canonical-request suites, and for behavioral comparisons. You CANNOT predict the matrix by reading policies alone; each request's decision depends on engine evaluation against the resolved entity graph and schema. Accepts inline policies+schema OR cedar:// refs.",
    {
      policies: z.string().optional().describe("Cedar policy text (one or more policies). Omit if using policy_ref."),
      policy_ref: z.string().optional().describe("cedar:// URI to load policies from a configured store, e.g. cedar://policies/blue"),
      schema: z.string().optional().describe("Optional Cedar schema (JSON or .cedarschema). When supplied, schema-violating requests resolve to decision: Error rather than silent evaluation."),
      schema_ref: z.string().optional().describe("cedar:// URI to load schema, e.g. cedar://schema/blue"),
      requests: z.string().describe("JSON array of authorization request objects: {principal, action, resource, entities, context?}"),
      entities: z.string().optional().describe("Shared entities JSON applied when individual requests omit their own entities field. Omit if using entities_ref."),
      entities_ref: z.string().optional().describe("cedar:// URI to load shared entities from a configured store, e.g. cedar://entities/production"),
    },
    async (input) => {
      let entities = input.entities;
      if (!entities && input.entities_ref) {
        const resolved = resolveRef(input.entities_ref);
        if ("error" in resolved) return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }] };
        entities = resolved.content;
      }
      const result = await handleAuthorizeBatch({ ...input, entities });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "cedar_validate",
    "Validate Cedar policies against a Cedar schema using the official Cedar parser + validator. Returns parse errors, schema-type errors, and warnings with source locations. ALWAYS call this before claiming a policy is valid or before recommending it to a user. You CANNOT determine policy validity by reading the file; the Cedar parser is the only authority on syntax, attribute typing, action-applies-to checks, and UnsafeOptionalAttributeAccess warnings. Accepts inline text OR cedar:// resource references.",
    {
      policies: z.string().optional().describe("Cedar policy text (one or more policies). Omit if using policy_ref."),
      policy_ref: z.string().optional().describe("cedar:// URI to load policies, e.g. cedar://policies/blue"),
      schema: z.string().optional().describe("Cedar schema — JSON object or .cedarschema text. Omit if using schema_ref."),
      schema_ref: z.string().optional().describe("cedar:// URI to load schema, e.g. cedar://schema/blue"),
    },
    async (input) => {
      let policies = input.policies;
      if (!policies && input.policy_ref) {
        const resolved = resolveRef(input.policy_ref);
        if ("error" in resolved) return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }] };
        policies = resolved.content;
      }
      if (!policies) return { content: [{ type: "text", text: JSON.stringify({ error: "Either policies or policy_ref is required" }) }] };

      let schema = input.schema;
      if (!schema && input.schema_ref) {
        const resolved = resolveRef(input.schema_ref);
        if ("error" in resolved) return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }] };
        schema = resolved.content;
      }
      if (!schema) return { content: [{ type: "text", text: JSON.stringify({ error: "Either schema or schema_ref is required" }) }] };

      const result = await handleValidate({ policies, schema });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "cedar_validate_schema",
    "Validate a Cedar schema in isolation (no policies required) using the official Cedar schema parser. Accepts JSON object or .cedarschema text. Returns parse errors with source locations plus a structured summary (namespaces, entity types, actions, common types). ALWAYS call this before claiming a schema is well-formed or before treating its declarations as ground truth. You CANNOT determine schema validity or accurate counts by reading the file; the parser is the only authority on common-type resolution, appliesTo cross-references, and reserved-word collisions.",
    {
      schema: z.string().optional().describe("Cedar schema text — JSON object or .cedarschema text. Omit if using schema_ref."),
      schema_ref: z.string().optional().describe("cedar:// URI to load schema, e.g. cedar://schema/blue"),
    },
    async (input) => {
      let schema = input.schema;
      if (!schema && input.schema_ref) {
        const resolved = resolveRef(input.schema_ref);
        if ("error" in resolved) return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }] };
        schema = resolved.content;
      }
      if (!schema) return { content: [{ type: "text", text: JSON.stringify({ error: "Either schema or schema_ref is required" }) }] };

      const result = await handleValidateSchema({ schema });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "cedar_format",
    "Format Cedar policies to the canonical Cedar style via the official formatter. ALWAYS use this when emitting Cedar text for storage, diffs, or display; do not hand-format. Hand-formatted output drifts from canonical style and produces noise in `cedar_diff_policy_stores` and code review. The formatter handles operator spacing, line wrapping, comment placement, and nested expression indentation per the Cedar reference implementation.",
    {
      policies: z.string().describe("Cedar policy text to format"),
      line_width: z.number().optional().describe("Maximum line width (default: 80)"),
      indent_width: z.number().optional().describe("Indent width in spaces (default: 2)"),
    },
    async (input) => {
      const result = await handleFormat(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "cedar_translate",
    "Translate between Cedar human-readable format and the official Cedar JSON format for policies or schemas. ALWAYS use this when converting between formats for storage, AVP deployment (which uses JSON), or AST inspection. Do NOT translate by hand: the Cedar JSON shape is non-obvious (templates use slot encoding, schemas resolve common types, conditions are nested op trees), and a hand-written translation will be silently wrong against the parser. Round-trip via this tool is the only safe path.",
    {
      input: z.string().describe("Cedar text or JSON to translate"),
      type: z.enum(["policy", "schema"]).describe("Whether the input is a policy or schema"),
      direction: z.enum(["to_json", "to_cedar"]).describe("Translation direction"),
    },
    async (input) => {
      const result = await handleTranslate(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "cedar_explain",
    "Explain one or more Cedar policies in structured form, derived from the parsed AST (not from text inspection). ALWAYS call this when summarizing what a policy permits, walking a user through inherited policies, or detecting Cedar patterns (RBAC role-membership, ABAC attribute conditions, ReBAC relationship checks, optional-attribute guards, path-matching with depth limiting). Reading the policy text does not reliably yield correct structural breakdown or pattern detection; the AST is the authority. Accepts a single policy, a template, or a full policy set.",
    {
      policy: z.string().describe("Cedar policy text (single policy, template, or policy set with multiple policies)"),
      schema: z.string().optional().describe("Optional Cedar schema for richer context"),
    },
    async (input) => {
      const result = await handleExplainMany(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "cedar_check_policy_change",
    "Diff an old vs new Cedar policy and classify the change against Amazon Verified Permissions UpdatePolicy mutability rules: in-place via UpdatePolicy, requires delete+recreate, or new-via-CreatePolicy. ALWAYS call this before recommending any modification to a policy in a deployed AVP store. Visually reading the diff does NOT tell you whether AVP will accept the update; only this tool encodes the actual API contract (effect / principal / resource scope are immutable; action and when/unless are mutable; static ↔ template-linked conversion is not supported).",
    {
      old_policy: z.string().describe("Original Cedar policy text"),
      new_policy: z.string().describe("Modified Cedar policy text"),
    },
    async (input) => {
      const result = await handleCheckChange(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "cedar_generate_sample_request",
    "Generate a complete Cedar authorization request (principal, action, resource, entities JSON) that will be allowed or denied by the given policy under the supplied schema. The generated request is verified by running it through the Cedar engine before return; the response field `ready_to_test: true` confirms the agreement. ALWAYS use this when a user needs a working test payload; constructing entity JSON by hand (correct uid format, required attributes, parent relationships, action-group entities) is error-prone and Cedar will silently reject a malformed entity graph.",
    {
      policy: z.string().describe("Cedar policy text (single policy)"),
      schema: z.string().describe("Cedar schema (JSON or .cedarschema format)"),
      target_decision: z.enum(["allow", "deny"]).describe("Generate a request that will be allowed or denied"),
    },
    async (input) => {
      const result = await handleGenerateSample(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "cedar_validate_entities",
    "Validate a Cedar entities JSON array against a schema using the official Cedar entities parser. Returns per-entity errors classified by kind: unknown_type, missing_required_attribute, type_mismatch, unknown_attribute, disallowed_parent_type, parse_error. ALWAYS call this before treating an entities file as ground truth for a downstream `cedar_authorize` call. You CANNOT predict by reading whether the entity graph will pass schema validation; only the parser checks required attributes, type compatibility, and allowed parent types per the schema's `memberOfTypes`. Schema is optional; without it only JSON shape is checked.",
    {
      entities: z.string().describe("JSON array of entity objects with uid, attrs, and parents"),
      schema: z.string().optional().describe("Cedar schema (JSON or .cedarschema) — enables type validation"),
      schema_ref: z.string().optional().describe("cedar:// URI to load schema, e.g. cedar://schema/blue"),
    },
    async (input) => {
      let schema = input.schema;
      if (!schema && input.schema_ref) {
        const resolved = resolveRef(input.schema_ref);
        if ("error" in resolved) return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }] };
        schema = resolved.content;
      }
      const result = await handleValidateEntities({ entities: input.entities, schema });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "cedar_diff_schema",
    "Structural diff of two Cedar schemas with AVP-aware risk classification per change (safe / review / breaking) and a reason string per change. ALWAYS call this before recommending a schema migration to a deployed store. A `diff` over the schema text does NOT tell you which changes break policies (e.g. removing a required attribute breaks every policy that reads it; widening principalTypes is safe; narrowing it is breaking). Only this tool normalizes both schemas via the parser, walks entity types / actions / common types / appliesTo / memberOfTypes, and tags each change. Each side accepts inline schema text (JSON or .cedarschema) OR a cedar://schema/{store} URI.",
    {
      blue: z.string().describe("Blue (baseline) schema — inline schema text or cedar://schema/{store} URI"),
      green: z.string().describe("Green (proposed) schema — inline schema text or cedar://schema/{store} URI"),
    },
    async (input) => {
      let blue = input.blue;
      let green = input.green;
      if (blue.startsWith("cedar://")) {
        const resolved = resolveRef(blue);
        if ("error" in resolved) return { content: [{ type: "text", text: JSON.stringify({ error: `blue: ${resolved.error}` }) }] };
        blue = resolved.content;
      }
      if (green.startsWith("cedar://")) {
        const resolved = resolveRef(green);
        if ("error" in resolved) return { content: [{ type: "text", text: JSON.stringify({ error: `green: ${resolved.error}` }) }] };
        green = resolved.content;
      }
      const result = await handleDiffSchema({ blue, green });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "cedar_diff_policy_stores",
    "Semantic + structural diff of two Cedar policy stores (blue vs green) with AVP immutability classification per change and an optional behavioral diff (run canonical authorization requests through both stores and surface decisions that flip). ALWAYS call this before recommending a deployment from a green/staging store to a blue/production store. A text diff CANNOT tell you which authorization decisions change between the two stores; only running both stores against the same requests does. Returns added / removed / modified policies, structured schema_diff (with safe/review/breaking risk), and (when behavioral_test_requests is supplied) per-request decision drift.",
    {
      blue: z.string().describe("Name of the blue (current/production) store — must be a configured MCP root"),
      green: z.string().describe("Name of the green (proposed/staging) store — must be a configured MCP root"),
      behavioral_test_requests: z.string().optional().describe("JSON array of authorization requests to run through both stores to detect decision drift"),
    },
    async (input) => {
      const result = await handleDiffStores(input, storeManager);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "cedar_advise",
    "ALWAYS call this before suggesting any Cedar policy modification or addition. Returns the structured project context you need to plan correctly: schema summary, policy inventory with AST-classified Cedar patterns (Membership/Relationship/Discretionary/hybrid) per file, intent-selected gotcha catalog, AVP UpdatePolicy mutability rules (in-place vs delete-recreate vs new), Cedar patterns reference, sequencing guidance, and explicit next steps. Reading policy files alone is INSUFFICIENT, because this tool encodes Cedar/AVP knowledge (AVP API rules, validation error categories, AST-based pattern classification) that does not live in the files. The bundle is deterministic (no LLM sampling); the calling assistant produces the plan from the bundle and verifies snippets with cedar_validate and cedar_check_policy_change.",
    {
      intent: z.string().describe("Natural-language description of what the user wants the authorization model to do. Keep the wording from the user verbatim where possible."),
      store_ref: z.string().optional().describe("cedar:// URI or store name to read current schema and policies from, e.g. cedar://policies/production or just 'production'. When omitted, the bundle still returns gotchas, AVP rules, and Cedar patterns but cannot ground the plan in actual project state."),
    },
    async (input) => {
      const result = handleAdvise(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "cedar_validate_template",
    "Validate a Cedar template policy against a schema using the official parser. Templates use slot placeholders (?principal, ?resource) bound at link time. Returns parse errors, schema-type errors, warnings, and detected slots. ALWAYS call this before claiming a template is valid or before linking it; the parser is the only authority on whether a template's slots are typed correctly against the schema's `appliesTo` and on whether the body's attribute access satisfies type rules. Visual inspection of a template does NOT catch slot-type mismatches or missing-attribute references.",
    {
      template: z.string().describe("Cedar template text — may contain ?principal and/or ?resource slot placeholders"),
      schema: z.string().describe("Cedar schema (JSON or .cedarschema format)"),
    },
    async (input) => {
      const result = await handleValidateTemplate(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "cedar_link_template",
    "Instantiate a Cedar template by binding its ?principal and/or ?resource slots to specific entity references. Returns the linked policy as Cedar text and (when a schema is supplied) validates the result as a static policy. ALWAYS use this tool to perform the substitution; do NOT hand-substitute slot text into the template body. The official substitution path uses `templateToJson` → JSON patch → `policyToText`, which preserves operator semantics and slot-position rules that a naïve string replace will silently break (e.g. for templates that reference the slot inside set or relation operators).",
    {
      template: z.string().describe("Cedar template text with ?principal and/or ?resource slots"),
      principal: z.string().optional().describe('Entity reference for the ?principal slot, e.g. App::User::"alice"'),
      resource: z.string().optional().describe('Entity reference for the ?resource slot, e.g. App::Document::"doc-42"'),
      schema: z.string().optional().describe("Cedar schema (JSON or .cedarschema) — if provided, the linked policy is validated against it"),
    },
    async (input) => {
      const result = await handleLinkTemplate(input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "cedar_list_templates",
    "List all Cedar template policies in a policy store configured via MCP Roots. Templates live in the templates/ subdirectory of the store root. Returns template IDs, content, and detected slot placeholders. ALWAYS call this when the user asks 'what templates are available?' or before recommending which template to link. The tool walks the configured store's templates/ directory via the same StoreManager other tools use, so the inventory matches what `cedar_link_template` and `cedar_validate_template` will actually resolve; a direct file listing may miss the store's namespacing convention or include unrelated files.",
    {
      store: z.string().describe("Store name (must be a configured MCP root)"),
    },
    async (input) => {
      const result = await handleListTemplates(input, storeManager);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "cedar_list_template_links",
    "List all template-linked policy instances in a policy store configured via MCP Roots. Links live in the template-links/ subdirectory. Each link records which template it uses and the slot values bound to it. ALWAYS call this when the user asks 'which policies in the store came from a template?' or before recommending a refactor across template links. The tool decodes the link record format the rest of the server uses; a direct file read would still need to parse and join links against templates to produce a usable inventory.",
    {
      store: z.string().describe("Store name (must be a configured MCP root)"),
    },
    async (input) => {
      const result = await handleListTemplateLinks(input, storeManager);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─── MCP Resources: cedar:// URI scheme ────────────────────────────────────

  // List all policy IDs in a store: cedar://policies/{store}
  server.resource(
    "cedar-policies-list",
    new ResourceTemplate("cedar://policies/{store}", { list: undefined }),
    async (_uri, variables) => {
      const storeName = variables["store"] as string;
      try {
        const policyIds = storeManager.listPolicies(storeName);
        return {
          contents: [{
            uri: `cedar://policies/${storeName}`,
            mimeType: "application/json",
            text: JSON.stringify(policyIds),
          }],
        };
      } catch (e) {
        return {
          contents: [{
            uri: `cedar://policies/${storeName}`,
            mimeType: "application/json",
            text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
          }],
        };
      }
    }
  );

  // Read a single policy: cedar://policies/{store}/{policy_id}
  server.resource(
    "cedar-policy",
    new ResourceTemplate("cedar://policies/{store}/{policy_id}", { list: undefined }),
    async (uri, variables) => {
      const storeName = variables["store"] as string;
      const policyId = variables["policy_id"] as string;
      try {
        const content = storeManager.readPolicy(storeName, policyId);
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: "text/plain",
            text: content,
          }],
        };
      } catch (e) {
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
          }],
        };
      }
    }
  );

  // Read schema for a store: cedar://schema/{store}
  server.resource(
    "cedar-schema",
    new ResourceTemplate("cedar://schema/{store}", { list: undefined }),
    async (uri, variables) => {
      const storeName = variables["store"] as string;
      try {
        const content = storeManager.readSchema(storeName);
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: "text/plain",
            text: content,
          }],
        };
      } catch (e) {
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
          }],
        };
      }
    }
  );

  // List all template IDs in a store: cedar://templates/{store}
  server.resource(
    "cedar-templates-list",
    new ResourceTemplate("cedar://templates/{store}", { list: undefined }),
    async (_uri, variables) => {
      const storeName = variables["store"] as string;
      try {
        const ids = storeManager.listTemplates(storeName);
        return { contents: [{ uri: `cedar://templates/${storeName}`, mimeType: "application/json", text: JSON.stringify(ids) }] };
      } catch (e) {
        return { contents: [{ uri: `cedar://templates/${storeName}`, mimeType: "application/json", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };
      }
    }
  );

  // Read a single template: cedar://templates/{store}/{template_id}
  server.resource(
    "cedar-template",
    new ResourceTemplate("cedar://templates/{store}/{template_id}", { list: undefined }),
    async (uri, variables) => {
      const storeName = variables["store"] as string;
      const templateId = variables["template_id"] as string;
      try {
        const content = storeManager.readTemplate(storeName, templateId);
        return { contents: [{ uri: uri.toString(), mimeType: "text/plain", text: content }] };
      } catch (e) {
        return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };
      }
    }
  );

  // List all template link IDs: cedar://template-links/{store}
  server.resource(
    "cedar-template-links-list",
    new ResourceTemplate("cedar://template-links/{store}", { list: undefined }),
    async (_uri, variables) => {
      const storeName = variables["store"] as string;
      try {
        const ids = storeManager.listTemplateLinks(storeName);
        return { contents: [{ uri: `cedar://template-links/${storeName}`, mimeType: "application/json", text: JSON.stringify(ids) }] };
      } catch (e) {
        return { contents: [{ uri: `cedar://template-links/${storeName}`, mimeType: "application/json", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };
      }
    }
  );

  // Read a single template link: cedar://template-links/{store}/{link_id}
  server.resource(
    "cedar-template-link",
    new ResourceTemplate("cedar://template-links/{store}/{link_id}", { list: undefined }),
    async (uri, variables) => {
      const storeName = variables["store"] as string;
      const linkId = variables["link_id"] as string;
      try {
        const data = storeManager.readTemplateLink(storeName, linkId);
        return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };
      }
    }
  );

  // List entity files in a store: cedar://entities/{store}
  server.resource(
    "cedar-entities-list",
    new ResourceTemplate("cedar://entities/{store}", { list: undefined }),
    async (_uri, variables) => {
      const storeName = variables["store"] as string;
      try {
        const ids = storeManager.listEntities(storeName);
        return { contents: [{ uri: `cedar://entities/${storeName}`, mimeType: "application/json", text: JSON.stringify(ids) }] };
      } catch (e) {
        return { contents: [{ uri: `cedar://entities/${storeName}`, mimeType: "application/json", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };
      }
    }
  );

  // Read a single entity file: cedar://entities/{store}/{file_id}
  server.resource(
    "cedar-entities",
    new ResourceTemplate("cedar://entities/{store}/{file_id}", { list: undefined }),
    async (uri, variables) => {
      const storeName = variables["store"] as string;
      const fileId = variables["file_id"] as string;
      try {
        const content = storeManager.readEntities(storeName, fileId);
        return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: content }] };
      } catch (e) {
        return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };
      }
    }
  );

  // ─── MCP Prompts: pre-canned templates the client surfaces as slash commands ──

  for (const p of PROMPT_DEFINITIONS) {
    server.prompt(p.name, p.description, p.argsSchema, p.handler);
  }

  return server;
}
