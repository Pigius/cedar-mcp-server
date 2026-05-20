import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleAuthorize } from "./tools/authorize.js";
import { handleValidate } from "./tools/validate.js";
import { handleFormat } from "./tools/format.js";
import { handleTranslate } from "./tools/translate.js";
import { handleExplainMany } from "./tools/explain.js";
import { handleCheckChange } from "./tools/check-change.js";
import { handleGenerateSample } from "./tools/generate-sample.js";
import { handleDiffStores } from "./tools/diff-stores.js";
import { storeManager } from "./resources/store-manager.js";
import { resolveRef } from "./resources/ref-resolver.js";

export const SERVER_NAME = "cedar-mcp-server";
export const SERVER_VERSION = "0.0.1";

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.tool(
    "cedar_authorize",
    "Evaluate a Cedar authorization request against policies and entities. Returns the decision (Allow/Deny) and which policies determined the outcome. Accepts inline policy text OR a cedar:// resource reference (policy_ref).",
    {
      policies: z.string().optional().describe("Cedar policy text (one or more policies). Omit if using policy_ref."),
      policy_ref: z.string().optional().describe("cedar:// URI to load policies from a configured store, e.g. cedar://policies/blue"),
      principal: z.string().describe('Principal entity reference, e.g. Namespace::Type::"id"'),
      action: z.string().describe('Action entity reference, e.g. Namespace::Action::"name"'),
      resource: z.string().describe('Resource entity reference, e.g. Namespace::Type::"id"'),
      entities: z.string().describe("JSON array of entity objects with uid, attrs, and parents"),
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

      const result = await handleAuthorize({ ...input, policies, schema });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "cedar_validate",
    "Validate Cedar policies against a Cedar schema. Returns validation errors with hints. Accepts inline text OR cedar:// resource references.",
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
    "cedar_format",
    "Format Cedar policies to canonical style.",
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
    "Translate between Cedar human-readable format and JSON format for policies or schemas.",
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
    "Explain one or more Cedar policies in structured, human-readable form. Accepts a single policy, a template, or a full policy set. Returns effect, scope breakdown, conditions, detected patterns, and a plain-English summary per policy.",
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
    "Check whether a Cedar policy change can be applied in-place in AWS Verified Permissions, or requires deleting and recreating the policy. Based on Cedar/AVP immutability rules.",
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
    "Generate a complete Cedar authorization request (principal, action, resource, entities) that will be allowed or denied by the given policy. Pass the result directly to cedar_authorize to verify.",
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
    "cedar_diff_policy_stores",
    "Semantic diff of two Cedar policy stores (blue vs green). Returns added, removed, and modified policies with AVP immutability classification per change, schema changes, and optional behavioral diff showing which authorization decisions would change.",
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

  return server;
}
