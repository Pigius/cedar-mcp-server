/**
 * E2E layer 1: protocol-level behavior.
 *
 * Tests the MCP protocol surface end-to-end through a real stdio MCP client.
 * Each test exercises behavior the server MUST honor per the MCP spec, with
 * a failure case stated explicitly so the test is not tautological.
 *
 * Transport choice: stdio. The MCP SDK normalizes the JSON-RPC layer, so
 * protocol-level behaviors are transport-agnostic except for session
 * management (HTTP-only, covered in http-smoke.test.ts). Running these
 * tests in stdio is faster and uses the same code path users hit via
 * Claude Code / Claude Desktop / Cursor.
 *
 * Run: npx vitest run test/integration/e2e/protocol
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(import.meta.dirname, "../../..");

function makeStdioClient(): { client: Client; transport: StdioClientTransport } {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    cwd: repoRoot,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "e2e-protocol", version: "1.0.0" },
    { capabilities: {} }
  );
  return { client, transport };
}

function parseToolResult(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const textBlock = r.content?.find((b) => b.type === "text");
  if (!textBlock?.text) throw new Error("No text content in tool result");
  return JSON.parse(textBlock.text);
}

const SCHEMA = JSON.stringify({
  DocMgmt: {
    entityTypes: {
      User: { memberOfTypes: [], shape: { type: "Record", attributes: { name: { type: "String", required: true } } } },
      Document: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
    },
    actions: { read: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Document"], context: { type: "Record", attributes: {} } } } },
  },
});
const POLICY = `permit (principal, action == DocMgmt::Action::"read", resource);`;

describe("e2e protocol", () => {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  beforeEach(async () => {
    const conn = makeStdioClient();
    client = conn.client;
    transport = conn.transport;
    await client.connect(transport);
  });

  afterEach(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    client = undefined;
    transport = undefined;
  });

  it("P1 — server advertises tools, resources, and prompts capabilities", async () => {
    // Failure case: if capabilities are wrong, MCP clients fall back to limited mode and
    // won't discover the registered surface. Catches misconfigured McpServer construction.
    const caps = client!.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeDefined();
  }, 20_000);

  it("P2 — listTools returns 17 distinct tools, no duplicates", async () => {
    // Failure case: a tool registered twice would show up twice in listTools, breaking
    // client UIs that key by name. Catches accidental double-registration in src/server.ts.
    const { tools } = await client!.listTools();
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(17);
    expect(names.length).toBe(unique.size);
  }, 20_000);

  it("P3 — every tool advertises a non-empty description and input schema", async () => {
    // Failure case: tools with empty descriptions render as blank entries in MCP clients.
    // Tools with missing input schemas cause clients to skip parameter validation.
    const { tools } = await client!.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.description!.length, `${tool.name} description length`).toBeGreaterThan(10);
      expect(tool.inputSchema, `${tool.name} input schema`).toBeDefined();
      expect((tool.inputSchema as { type?: string }).type).toBe("object");
    }
  }, 20_000);

  it("P4 — listPrompts returns the 3 registered prompts with required args declared", async () => {
    // Failure case: missing 'required: true' on args means clients let users submit
    // empty values, which then break the handler. Catches arg-schema regressions.
    const { prompts } = await client!.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain("cedar-review-policy-diff");
    expect(names).toContain("cedar-explain-denial");
    expect(names).toContain("cedar-avp-migration-checklist");
    expect(prompts).toHaveLength(3);

    const reviewPrompt = prompts.find((p) => p.name === "cedar-review-policy-diff")!;
    const requiredArgs = (reviewPrompt.arguments ?? []).filter((a) => a.required === true).map((a) => a.name);
    expect(requiredArgs).toContain("blue_store");
    expect(requiredArgs).toContain("green_store");
  }, 20_000);

  it("P5 — tools/call to an unknown tool returns isError:true, not silent success", async () => {
    // Failure case: silently returning success on unknown tools masks client bugs.
    // Per the MCP SDK contract, tool errors surface as { content, isError: true }
    // rather than JSON-RPC rejections. The envelope MUST be tagged isError so
    // clients can distinguish a tool's deliberate text output from an error.
    const result = await client!.callTool({ name: "cedar_nonexistent_tool", arguments: {} }) as { isError?: boolean; content: unknown[] };
    expect(result.isError).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
  }, 20_000);

  it("P6 — tools/call with missing required arg fails with a structured error", async () => {
    // Failure case: missing 'policies' AND 'policy_ref' on cedar_validate. The server
    // returns its own structured error message in the tool result (not a JSON-RPC reject)
    // because the args are optional individually but one of them is required at runtime.
    // We assert the error path produces a JSON body with an 'error' field.
    const result = await client!.callTool({
      name: "cedar_validate",
      arguments: { /* neither policies nor policy_ref */ },
    }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    const textBlock = result.content.find((b) => b.type === "text");
    expect(textBlock?.text).toBeTruthy();
    const parsed = JSON.parse(textBlock!.text!);
    // Either isError on the envelope OR an 'error' field in the body — both are valid
    // shapes the server uses in practice. Test the union.
    const hasError = result.isError === true || typeof parsed.error === "string";
    expect(hasError).toBe(true);
  }, 20_000);

  it("P7 — concurrent tool calls return all results without interleaving", async () => {
    // Failure case: if the server reuses a per-request buffer or has a race in
    // response routing, two concurrent calls could swap their results. This is
    // exactly the bug Streamable HTTP's session ID guards against — but stdio
    // uses correlation IDs, so the SAME bug class is possible if mishandled.
    const calls = [
      client!.callTool({ name: "cedar_validate", arguments: { policies: POLICY, schema: SCHEMA } }),
      client!.callTool({ name: "cedar_format", arguments: { policies: POLICY } }),
      client!.callTool({ name: "cedar_translate", arguments: { input: POLICY, type: "policy", direction: "to_json" } }),
    ];
    const [validateRaw, formatRaw, translateRaw] = await Promise.all(calls);

    const validate = parseToolResult(validateRaw) as { valid: boolean; policy_count: number };
    const format = parseToolResult(formatRaw) as { formatted: string | null; error: string | null };
    const translate = parseToolResult(translateRaw) as { output: string | null; error: string | null };

    // Each result must be of its own shape — proves correlation IDs routed correctly.
    // If the server had swapped responses, validate's shape would not have .valid,
    // format would not have .formatted, etc.
    expect(validate.valid).toBe(true);
    expect(validate.policy_count).toBe(1);
    expect(format.formatted).toBeTruthy();
    expect(format.formatted).toContain("permit");
    expect(translate.output).toBeTruthy();
    // Translate to_json output is a JSON string of the AST
    const translatedAst = JSON.parse(translate.output!);
    expect(translatedAst.effect).toBe("permit");
  }, 30_000);

  it("P8 — sequential calls don't accumulate hidden state between requests", async () => {
    // Failure case: an mcp server that mutates module-level state per request
    // could surface the previous call's data in the current one. Probe by
    // calling validate twice with different inputs and confirming each
    // returns its own result, not the previous.
    const r1 = parseToolResult(
      await client!.callTool({ name: "cedar_validate", arguments: { policies: POLICY, schema: SCHEMA } })
    ) as { valid: boolean; policy_count: number };
    expect(r1.valid).toBe(true);
    expect(r1.policy_count).toBe(1);

    const r2 = parseToolResult(
      await client!.callTool({
        name: "cedar_validate",
        arguments: {
          policies: POLICY + "\n" + POLICY,  // two policies
          schema: SCHEMA,
        },
      })
    ) as { valid: boolean; policy_count: number };
    expect(r2.valid).toBe(true);
    expect(r2.policy_count).toBe(2);
  }, 30_000);

  it("P9 — prompts/get with required args returns assembled messages", async () => {
    // Failure case: the prompt handler crashes or returns empty messages array,
    // which breaks the client's slash-command UX. We assert the assembled
    // message text mentions the expected tool names (proving the handler ran
    // the substitution, not just returned a template).
    const result = await client!.getPrompt({
      name: "cedar-explain-denial",
      arguments: {
        principal: 'App::User::"alice"',
        action: 'App::Action::"read"',
        resource: 'App::Document::"doc-1"',
        store: "production",
      },
    });
    expect(result.messages.length).toBeGreaterThan(0);
    const allText = result.messages
      .map((m) => (m.content.type === "text" ? m.content.text : ""))
      .join(" ");
    expect(allText).toContain("cedar_authorize");
    expect(allText).toContain("alice");
    expect(allText).toContain("production");
  }, 20_000);

  it("P10 — prompts/get with missing required arg rejects with a clear error", async () => {
    // Failure case: prompt handler silently substitutes 'undefined' for missing
    // required args, producing assembled text like 'authorize the request for undefined'.
    // The MCP layer (the prompts validator in the SDK) must reject this first.
    await expect(
      client!.getPrompt({
        name: "cedar-explain-denial",
        // missing principal, action, resource, store — all required
        arguments: {},
      })
    ).rejects.toBeDefined();
  }, 20_000);

  it("P11 — resources/read against an unconfigured store returns a structured error in the resource body", async () => {
    // Failure case: with no roots configured (this server was spawned without
    // any client-side roots support), reading cedar://policies/nonexistent
    // should return a JSON error body, not a transport-level fault. We assert
    // the response is well-formed with an 'error' field.
    const result = await client!.readResource({ uri: "cedar://policies/nonexistent" });
    expect(result.contents.length).toBeGreaterThan(0);
    const first = result.contents[0]!;
    const bodyText = typeof first.text === "string" ? first.text : "";
    // The error path returns JSON like { "error": "..." }
    const parsed = JSON.parse(bodyText);
    expect(parsed.error).toBeDefined();
    expect(typeof parsed.error).toBe("string");
  }, 20_000);
});
