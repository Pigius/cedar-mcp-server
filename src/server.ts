import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleAuthorize } from "./tools/authorize.js";
import { handleValidate } from "./tools/validate.js";

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

  return server;
}
