/**
 * Integration smoke test: spawns cedar-mcp-server via stdio and exercises
 * cedar_validate and cedar_authorize through a real MCP client transport.
 *
 * Closes the mock-only test gap from Phase 4. Runs separately from unit tests:
 *   npx vitest run test/integration
 *
 * Falls back to library-mode if process spawn proves brittle (see fallback note
 * below). Currently uses real stdio spawn via tsx.
 */
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─── Dataset 1 fixtures ────────────────────────────────────────────────────────

const DOCMGMT_SCHEMA = JSON.stringify({
  DocMgmt: {
    entityTypes: {
      User: {
        memberOfTypes: ["Role"],
        shape: {
          type: "Record",
          attributes: {
            name: { type: "String", required: true },
            email: { type: "String", required: true },
          },
        },
      },
      Role: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
      Document: {
        memberOfTypes: ["Folder"],
        shape: {
          type: "Record",
          attributes: {
            owner: { type: "String", required: true },
            classification: { type: "String", required: true },
          },
        },
      },
      Folder: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
    },
    actions: {
      read: {
        appliesTo: {
          principalTypes: ["User"],
          resourceTypes: ["Document"],
          context: { type: "Record", attributes: {} },
        },
        memberOf: [],
      },
      write: {
        appliesTo: {
          principalTypes: ["User"],
          resourceTypes: ["Document"],
          context: { type: "Record", attributes: {} },
        },
        memberOf: [],
      },
      delete: {
        appliesTo: {
          principalTypes: ["User"],
          resourceTypes: ["Document"],
          context: { type: "Record", attributes: {} },
        },
        memberOf: [],
      },
    },
  },
});

const ADMIN_POLICY = `permit (
  principal in DocMgmt::Role::"admin",
  action,
  resource
);`;

const EDITOR_POLICY = `permit (
  principal in DocMgmt::Role::"editor",
  action in [DocMgmt::Action::"read", DocMgmt::Action::"write"],
  resource
);`;

// Alice is admin, doc-public is public classification
const ALICE_ENTITIES = JSON.stringify([
  {
    uid: { type: "DocMgmt::User", id: "alice" },
    attrs: { name: "Alice Smith", email: "alice@example.com" },
    parents: [{ type: "DocMgmt::Role", id: "admin" }],
  },
  { uid: { type: "DocMgmt::Role", id: "admin" }, attrs: {}, parents: [] },
  {
    uid: { type: "DocMgmt::Document", id: "doc-public" },
    attrs: { owner: "alice", classification: "public" },
    parents: [{ type: "DocMgmt::Folder", id: "shared" }],
  },
  { uid: { type: "DocMgmt::Folder", id: "shared" }, attrs: {}, parents: [] },
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(): { client: Client; transport: StdioClientTransport } {
  const repoRoot = join(import.meta.dirname, "../..");
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    cwd: repoRoot,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "smoke-test-client", version: "1.0.0" },
    { capabilities: {} }
  );
  return { client, transport };
}

function parseToolResult(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const textBlock = r.content?.find(b => b.type === "text");
  if (!textBlock?.text) throw new Error("No text content in tool result");
  return JSON.parse(textBlock.text);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("integration smoke", () => {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  afterEach(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    client = undefined;
    transport = undefined;
  });

  it("S1 — server lists all 17 tools", async () => {
    const conn = makeClient();
    client = conn.client;
    transport = conn.transport;
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);

    expect(names).toContain("cedar_validate");
    expect(names).toContain("cedar_authorize");
    expect(names).toContain("cedar_authorize_batch");
    expect(names).toContain("cedar_format");
    expect(names).toContain("cedar_translate");
    expect(names).toContain("cedar_explain");
    expect(names).toContain("cedar_check_policy_change");
    expect(names).toContain("cedar_generate_sample_request");
    expect(names).toContain("cedar_advise");
    expect(names).toContain("cedar_diff_policy_stores");
    expect(names).toContain("cedar_validate_template");
    expect(names).toContain("cedar_link_template");
    expect(names).toContain("cedar_list_templates");
    expect(names).toContain("cedar_list_template_links");
    expect(names).toContain("cedar_validate_schema");
    expect(names).toContain("cedar_diff_schema");
    expect(names).toContain("cedar_validate_entities");
    expect(names).toHaveLength(17);
  }, 15_000);

  it("S2 — cedar_validate returns valid:true for correct policy + schema", async () => {
    const conn = makeClient();
    client = conn.client;
    transport = conn.transport;
    await client.connect(transport);

    const raw = await client.callTool({
      name: "cedar_validate",
      arguments: {
        policies: ADMIN_POLICY + "\n" + EDITOR_POLICY,
        schema: DOCMGMT_SCHEMA,
      },
    });

    const result = parseToolResult(raw) as { valid: boolean; errors: unknown[]; policy_count: number };
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.policy_count).toBe(2);
  }, 15_000);

  it("S3 — cedar_authorize returns Allow for alice reading doc-public", async () => {
    const conn = makeClient();
    client = conn.client;
    transport = conn.transport;
    await client.connect(transport);

    const raw = await client.callTool({
      name: "cedar_authorize",
      arguments: {
        policies: ADMIN_POLICY,
        principal: 'DocMgmt::User::"alice"',
        action: 'DocMgmt::Action::"read"',
        resource: 'DocMgmt::Document::"doc-public"',
        entities: ALICE_ENTITIES,
        schema: DOCMGMT_SCHEMA,
      },
    });

    const result = parseToolResult(raw) as { decision: string; determining_policies: string[] };
    expect(result.decision).toBe("Allow");
    expect(result.determining_policies).toHaveLength(1);
  }, 15_000);
});
