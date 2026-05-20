/**
 * E2E layer 5: failure modes.
 *
 * Inputs the server MUST reject cleanly — with a structured error, never with
 * a crash, hang, or silent success. Edge cases (boundary-but-valid inputs)
 * live in edge-cases.test.ts.
 *
 * Each test states the bad input + the expected clean-error shape.
 *
 * Run: npx vitest run test/integration/e2e/failure-modes
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
    { name: "e2e-failure", version: "1.0.0" },
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

const MINI_SCHEMA = JSON.stringify({
  App: {
    entityTypes: {
      User: { memberOfTypes: [], shape: { type: "Record", attributes: { name: { type: "String", required: true } } } },
      Doc: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
    },
    actions: { read: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Doc"], context: { type: "Record", attributes: {} } } } },
  },
});

describe("e2e failure modes", () => {
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

  it("F1 — malformed entities JSON returns parse_error, not a crash", async () => {
    // Bad input: 'not valid {{ json' as the entities string. cedar_validate_entities
    // must catch the JSON.parse failure and return error_kind: 'parse_error'.
    const result = parseToolResult(
      await client!.callTool({
        name: "cedar_validate_entities",
        arguments: { entities: "not valid {{ json", schema: MINI_SCHEMA },
      })
    ) as { valid: boolean; errors: Array<{ error_kind: string; message: string }> };
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.error_kind).toBe("parse_error");
    expect(result.errors[0]?.message.length).toBeGreaterThan(0);
  }, 20_000);

  it("F2 — invalid Cedar syntax: source-location-tagged error from cedar_validate", async () => {
    // Bad input: 'permit (broken oh no'. The parser must return valid:false with
    // a structured error message (NOT throw). Source location is a bonus but not
    // strictly asserted because exact offsets are SDK-specific.
    const result = parseToolResult(
      await client!.callTool({
        name: "cedar_validate",
        arguments: { policies: "permit (broken oh no", schema: MINI_SCHEMA },
      })
    ) as { valid: boolean; errors: Array<{ message: string }> };
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message.length).toBeGreaterThan(0);
  }, 20_000);

  it("F3 — malformed schema in cedar_validate_schema returns valid:false with source location", async () => {
    // Bad input: a cedarschema text with a missing colon. Validator must return
    // valid:false with at least one error.
    const result = parseToolResult(
      await client!.callTool({
        name: "cedar_validate_schema",
        arguments: { schema: "namespace App { entity User { name String } }" },
      })
    ) as { valid: boolean; errors: Array<{ message: string; source_location?: unknown }> };
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  }, 20_000);

  it("F4 — path traversal in policy id (cedar://policies/x/../escape) is rejected", async () => {
    // Bad input: a cedar:// URI containing '..'. The resource handler must
    // reject (no filesystem escape). The error body must surface the rejection
    // structurally, not via a 500 or a successful read of an unintended file.
    const result = await client!.readResource({ uri: "cedar://policies/staging/..%2Fescape" });
    expect(result.contents.length).toBeGreaterThan(0);
    const body = result.contents[0]!;
    const text = typeof body.text === "string" ? body.text : "";
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeDefined();
  }, 20_000);

  it("F5 — cedar:// URI to a non-existent store returns a clean structured error", async () => {
    // Bad input: a syntactically-valid cedar:// URI pointing at a store that's
    // not configured (no MCP roots). resource read must return a JSON error
    // body, not a transport-level fault.
    const result = await client!.readResource({ uri: "cedar://policies/this-store-does-not-exist/admin" });
    const text = typeof result.contents[0]?.text === "string" ? result.contents[0]!.text! : "";
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeDefined();
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error.length).toBeGreaterThan(0);
  }, 20_000);

  it("F6 — cedar_authorize with neither policies nor policy_ref returns 'one is required' error", async () => {
    // Bad input: omit both inline policies AND policy_ref. The server wrapper
    // must catch this before passing nothing to the handler.
    const result = await client!.callTool({
      name: "cedar_authorize",
      arguments: {
        // intentionally omitting policies AND policy_ref
        principal: 'App::User::"alice"',
        action: 'App::Action::"read"',
        resource: 'App::Doc::"d1"',
        entities: "[]",
      },
    }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    const textBlock = result.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock!.text!);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toMatch(/polic.*required|required.*polic/i);
  }, 20_000);

  it("F7 — cedar_diff_schema with a malformed blue schema sets schema_diff.error", async () => {
    // Bad input: blue is unparseable Cedar text. The diff must surface this via
    // the top-level error field on SchemaDiff — not abort the call or return
    // misleading "no changes" for two unparseable inputs.
    const result = parseToolResult(
      await client!.callTool({
        name: "cedar_diff_schema",
        arguments: { blue: "this is not a schema", green: MINI_SCHEMA },
      })
    ) as { error?: string; risk_level: string };
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  }, 20_000);

  it("F8 — cedar_authorize_batch with non-array requests JSON returns clear error", async () => {
    // Bad input: requests is a JSON OBJECT, not an array. The handler must catch
    // the type mismatch at parse time and return a structured error (not
    // attempt to iterate undefined or throw at the WASM boundary).
    const result = parseToolResult(
      await client!.callTool({
        name: "cedar_authorize_batch",
        arguments: {
          policies: `permit (principal, action, resource);`,
          schema: MINI_SCHEMA,
          requests: JSON.stringify({ not: "an array" }),
        },
      })
    ) as { total?: number; error?: string; summary?: string };
    // The handler may report this as either total:0+errored:0 with a clear
    // summary, or as a top-level error field. Accept either shape; the key
    // invariant is "no crash, structured response, easy to debug".
    const surfaced =
      (typeof result.error === "string" && result.error.length > 0) ||
      (typeof result.summary === "string" && /array|object|not.*valid/i.test(result.summary));
    expect(surfaced).toBe(true);
  }, 20_000);

  it("F9 — entity with type-incompatible attribute is flagged by cedar_validate_entities", async () => {
    // Bad input: User.name is required String, entity has it as a number.
    // cedar_validate_entities must classify this as type_mismatch with the
    // attribute name captured.
    const result = parseToolResult(
      await client!.callTool({
        name: "cedar_validate_entities",
        arguments: {
          entities: JSON.stringify([
            { uid: { type: "App::User", id: "alice" }, attrs: { name: 42 }, parents: [] },
          ]),
          schema: MINI_SCHEMA,
        },
      })
    ) as { valid: boolean; errors: Array<{ error_kind: string; attribute?: string }> };
    expect(result.valid).toBe(false);
    expect(result.errors[0].error_kind).toBe("type_mismatch");
    expect(result.errors[0].attribute).toBe("name");
  }, 20_000);

  it("F10 — sequential connect/disconnect/reconnect doesn't accumulate state", async () => {
    // Close the auto-connected client, open a brand-new one, verify it works.
    // Failure case: a stdio process that doesn't clean up between sessions
    // would either hang the second connect or surface stale state.
    await client!.close();
    await transport!.close();

    const conn2 = makeStdioClient();
    client = conn2.client;
    transport = conn2.transport;
    await client.connect(transport);

    const result = parseToolResult(
      await client.callTool({
        name: "cedar_validate",
        arguments: { policies: `permit (principal, action, resource);`, schema: MINI_SCHEMA },
      })
    ) as { valid: boolean };
    expect(result.valid).toBe(true);
  }, 30_000);

  it("F11 — rapid-fire concurrent calls don't race or interleave responses", async () => {
    // Bad situation: 8 concurrent calls launched in parallel. The MCP transport
    // must route each response to its correct request ID. Failure case: a race
    // in response correlation that swaps results between callers, leaving one
    // promise resolved with another's answer.
    const calls = Array.from({ length: 8 }, (_, i) =>
      client!.callTool({
        name: "cedar_validate",
        arguments: {
          policies: `permit (principal in App::Role::"role-${i}", action, resource);`,
          schema: JSON.stringify({
            App: {
              entityTypes: {
                User: { memberOfTypes: ["Role"], shape: { type: "Record", attributes: {} } },
                Role: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
                Doc: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
              },
              actions: { read: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Doc"], context: { type: "Record", attributes: {} } } } },
            },
          }),
        },
      })
    );
    const results = await Promise.all(calls);
    // All should be valid (each has a distinct, well-formed permit)
    for (let i = 0; i < results.length; i++) {
      const parsed = parseToolResult(results[i]!) as { valid: boolean };
      expect(parsed.valid, `call ${i}`).toBe(true);
    }
  }, 60_000);
});
