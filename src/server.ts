import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleAuthorize } from "./tools/authorize.js";
import { handleValidate } from "./tools/validate.js";
import { handleFormat } from "./tools/format.js";
import { handleTranslate } from "./tools/translate.js";
import { handleExplain } from "./tools/explain.js";
import { handleCheckChange } from "./tools/check-change.js";
import { handleGenerateSample } from "./tools/generate-sample.js";

export const SERVER_NAME = "cedar-mcp-server";
export const SERVER_VERSION = "0.0.1";

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.tool(
    "cedar_authorize",
    "Evaluate a Cedar authorization request against policies and entities. Returns the decision (Allow/Deny) and which policies determined the outcome.",
    {
      policies: z.string().describe("Cedar policy text (one or more policies)"),
      principal: z.string().describe('Principal entity reference, e.g. Namespace::Type::"id"'),
      action: z.string().describe('Action entity reference, e.g. Namespace::Action::"name"'),
      resource: z.string().describe('Resource entity reference, e.g. Namespace::Type::"id"'),
      entities: z.string().describe("JSON array of entity objects with uid, attrs, and parents"),
      schema: z.string().optional().describe("Optional Cedar schema (JSON or .cedarschema format) — enables request validation"),
      context: z.string().optional().describe("Optional JSON object with context attributes"),
    },
    async (input) => {
      const result = await handleAuthorize(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "cedar_validate",
    "Validate Cedar policies against a Cedar schema. Returns validation errors with hints.",
    {
      policies: z.string().describe("Cedar policy text (one or more policies)"),
      schema: z.string().describe("Cedar schema — JSON object or Cedar schema text (.cedarschema format)"),
    },
    async (input) => {
      const result = await handleValidate(input);
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
    "Explain a Cedar policy in structured, human-readable form. Returns effect, scope breakdown, conditions, detected patterns, and a plain-English summary.",
    {
      policy: z.string().describe("Cedar policy text (single policy or template)"),
      schema: z.string().optional().describe("Optional Cedar schema for richer context"),
    },
    async (input) => {
      const result = await handleExplain(input);
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

  return server;
}
