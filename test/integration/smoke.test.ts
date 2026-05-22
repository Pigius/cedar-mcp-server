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
import { basename, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema, ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

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

  it("S4 — every tool description is non-trivially long and asserts necessity (MUST/ALWAYS/CANNOT/INSUFFICIENT)", async () => {
    const conn = makeClient();
    client = conn.client;
    transport = conn.transport;
    await client.connect(transport);

    const { tools } = await client.listTools();
    const necessityMarker = /\b(ALWAYS|MUST|CANNOT|INSUFFICIENT|do NOT|Do NOT)\b/;
    const failures: string[] = [];
    for (const tool of tools) {
      const desc = tool.description ?? "";
      if (desc.length <= 100) {
        failures.push(`${tool.name}: description too short (${desc.length} chars)`);
      }
      if (!necessityMarker.test(desc)) {
        failures.push(`${tool.name}: no necessity marker (MUST/ALWAYS/CANNOT/INSUFFICIENT/do NOT) in description`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  }, 15_000);

  it("S6 — stdio: client advertising roots populates resources/list with cedar:// URIs (H2 end-to-end)", async () => {
    // Round 3 (2026-05-22) observed `listMcpResources(server: "cedar")` returning empty
    // when Claude Code was used via stdio with no `--root` flag. This test isolates the
    // server-side path: a client that DOES advertise roots via the MCP `roots/list`
    // handler should see the cedar:// resource scheme populated. If this passes, the
    // round-3 empty result is on the client (Claude Code stdio not advertising the
    // workspace as a root), not the server.

    const sandbox = mkdtempSync(join(tmpdir(), "cedar-stdio-roots-"));
    mkdirSync(join(sandbox, "policies"));
    mkdirSync(join(sandbox, "entities"));
    writeFileSync(join(sandbox, "schema.cedarschema"),
      `namespace DocMgmt {\n  entity Role;\n  entity User in [Role];\n  entity Document;\n  action "read" appliesTo { principal: User, resource: Document };\n}\n`);
    writeFileSync(join(sandbox, "policies", "admin.cedar"),
      `permit (principal in DocMgmt::Role::"admin", action, resource);\n`);
    writeFileSync(join(sandbox, "entities", "sample.json"), "[]");

    const repoRoot = join(import.meta.dirname, "../..");
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/index.ts"],
      cwd: repoRoot,
      stderr: "pipe",
    });
    // Critical: declare roots capability so the server's `listRoots()` is allowed.
    const rootsClient = new Client(
      { name: "smoke-test-roots-client", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } }
    );
    rootsClient.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: `file://${sandbox}`, name: "stdio-test-store" }],
    }));
    client = rootsClient;

    try {
      await rootsClient.connect(transport);

      // The server's `oninitialized` callback fires async after the initialize
      // handshake returns. Trigger it deterministically by sending a
      // notifications/roots/list_changed: index.ts listens for this and
      // re-runs loadRootsStdio, which we can await client-side via the
      // round-trip (the SDK serializes notifications behind subsequent requests).
      await rootsClient.sendRootsListChanged();

      // Now poll resources/list briefly; the loadRootsStdio handler runs async on
      // the server side after the notification, so allow a short retry window.
      let resources: Array<{ uri: string; name?: string }> = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        const r = await rootsClient.listResources();
        resources = r.resources;
        if (resources.length > 0) break;
        await new Promise((res) => setTimeout(res, 100));
      }
      const uris = resources.map((r) => r.uri);

      // Per-item resources for our temp store
      expect(uris).toContain("cedar://policies/stdio-test-store/admin");
      expect(uris).toContain("cedar://schema/stdio-test-store");
      expect(uris).toContain("cedar://entities/stdio-test-store/sample");

      // Index resources
      expect(uris).toContain("cedar://policies/stdio-test-store");
      expect(uris).toContain("cedar://entities/stdio-test-store");

      expect(uris.length).toBeGreaterThanOrEqual(5);
    } finally {
      try { await rootsClient.close(); } catch { /* ignore */ }
      try { await transport.close(); } catch { /* ignore */ }
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 30_000);

  it("S6b — stdio: cwd-fallback notifies resources/list_changed so cache-based clients see the store (Round 4 Scenario E)", async () => {
    // Round 4 (2026-05-22) observed `listMcpResources(server: "cedar")` returning empty
    // when Claude Code stdio launched the server in a Cedar workspace cwd without
    // advertising roots. Root cause is timing: the cwd-fallback path in loadRootsStdio
    // populates StoreManager asynchronously inside `oninitialized`, which runs AFTER
    // the initialize handshake. A client that snapshots `resources/list` once on
    // connect (the standard MCP cache pattern, what Claude Code does) reads it
    // before the store exists, gets empty, and never refetches.
    //
    // The fix: after loadRootsStdio populates StoreManager, the server must emit
    // `notifications/resources/list_changed` so cache-aware clients invalidate and
    // refetch. This test fails until that notification is wired.

    const sandbox = mkdtempSync(join(tmpdir(), "cedar-stdio-cwd-"));
    mkdirSync(join(sandbox, "policies"));
    mkdirSync(join(sandbox, "entities"));
    writeFileSync(join(sandbox, "schema.cedarschema"),
      `namespace DocMgmt {\n  entity Role;\n  entity User in [Role];\n  entity Document;\n  action "read" appliesTo { principal: User, resource: Document };\n}\n`);
    writeFileSync(join(sandbox, "policies", "admin.cedar"),
      `permit (principal in DocMgmt::Role::"admin", action, resource);\n`);
    writeFileSync(join(sandbox, "entities", "sample.json"), "[]");

    const repoRoot = join(import.meta.dirname, "../..");
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", join(repoRoot, "src/index.ts")],
      cwd: sandbox, // server's cwd is the workspace, so 10d cwd fallback fires
      stderr: "pipe",
    });
    // Critical: NO roots capability declared. This mirrors a real Claude Code
    // stdio client that does not advertise the workspace as a root. The server
    // must take the cwd-fallback path AND notify list_changed afterwards.
    const noRootsClient = new Client(
      { name: "smoke-test-cwd-client", version: "1.0.0" },
      { capabilities: {} }
    );
    client = noRootsClient;

    // Track resources/list_changed notifications. Server should emit at least one
    // after the cwd-fallback populates StoreManager.
    let listChangedCount = 0;
    let listChangedReceived: () => void = () => {};
    const listChangedPromise = new Promise<void>((resolve) => { listChangedReceived = resolve; });
    noRootsClient.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      listChangedCount += 1;
      listChangedReceived();
    });

    try {
      await noRootsClient.connect(transport);

      // Snapshot resources immediately. The cwd-fallback runs async in
      // `oninitialized`; this call MAY race ahead of it and return empty.
      // That race is exactly the user-facing bug — empty here is fine as long
      // as the server notifies list_changed and a subsequent fetch returns the
      // populated list.
      await noRootsClient.listResources();

      // Wait for at least one resources/list_changed notification with a generous
      // timeout. Without the fix this never fires.
      const timeoutMs = 5000;
      await Promise.race([
        listChangedPromise,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error(
          `Timed out after ${timeoutMs}ms waiting for notifications/resources/list_changed. ` +
          `Server populated StoreManager via cwd-fallback but never told the client to refetch — ` +
          `cache-based clients (e.g. Claude Code) stay stuck on the empty initial snapshot.`,
        )), timeoutMs)),
      ]);

      expect(listChangedCount).toBeGreaterThanOrEqual(1);

      // After the notification, a fresh listResources MUST return the populated set.
      const { resources } = await noRootsClient.listResources();
      const uris = resources.map((r) => r.uri);
      const storeName = basename(sandbox);

      expect(uris).toContain(`cedar://policies/${storeName}/admin`);
      expect(uris).toContain(`cedar://schema/${storeName}`);
      expect(uris).toContain(`cedar://entities/${storeName}/sample`);
      expect(uris).toContain(`cedar://policies/${storeName}`);
      expect(uris).toContain(`cedar://entities/${storeName}`);
      expect(uris.length).toBeGreaterThanOrEqual(5);
    } finally {
      try { await noRootsClient.close(); } catch { /* ignore */ }
      try { await transport.close(); } catch { /* ignore */ }
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 30_000);

  it("S6c — stdio: cwd-fallback is loaded synchronously so the VERY FIRST resources/list after initialize is already populated (Round 5 Scenario E fix)", async () => {
    // Round 5 (2026-05-22) ran with kickoff-11 11a's notification path and
    // STILL FAILED Scenario E: Claude Code's `listMcpResources` did not
    // invalidate its cache on `notifications/resources/list_changed`. The
    // spec-correct fix wasn't user-correct. kickoff-12 12a's fix is structural:
    // populate StoreManager synchronously in runStdio BEFORE
    // `await server.connect(transport)`, so by the time the client can send
    // ANY request, the store already exists. This test exercises the new
    // contract directly: NO polling, NO waiting on notifications, the very
    // first listResources after initialize must return the populated store.

    const sandbox = mkdtempSync(join(tmpdir(), "cedar-stdio-sync-"));
    mkdirSync(join(sandbox, "policies"));
    mkdirSync(join(sandbox, "entities"));
    writeFileSync(join(sandbox, "schema.cedarschema"),
      `namespace DocMgmt {\n  entity Role;\n  entity User in [Role];\n  entity Document;\n  action "read" appliesTo { principal: User, resource: Document };\n}\n`);
    writeFileSync(join(sandbox, "policies", "admin.cedar"),
      `permit (principal in DocMgmt::Role::"admin", action, resource);\n`);
    writeFileSync(join(sandbox, "entities", "sample.json"), "[]");

    const repoRoot = join(import.meta.dirname, "../..");
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", join(repoRoot, "src/index.ts")],
      cwd: sandbox,
      stderr: "pipe",
    });
    // No roots capability declared. Mirrors Claude Code stdio.
    const noRootsClient = new Client(
      { name: "smoke-test-sync-client", version: "1.0.0" },
      { capabilities: {} }
    );
    client = noRootsClient;

    try {
      await noRootsClient.connect(transport);

      // First request after connect. No polling. No notification wait. If
      // the store is empty here, the sync cwd-fallback did not fire before
      // the transport accepted this request — that is the Round 5 bug.
      const { resources } = await noRootsClient.listResources();
      const uris = resources.map((r) => r.uri);
      const storeName = basename(sandbox);

      expect(uris).toContain(`cedar://policies/${storeName}/admin`);
      expect(uris).toContain(`cedar://schema/${storeName}`);
      expect(uris).toContain(`cedar://entities/${storeName}/sample`);
      expect(uris).toContain(`cedar://policies/${storeName}`);
      expect(uris).toContain(`cedar://entities/${storeName}`);
      expect(uris.length).toBeGreaterThanOrEqual(5);
    } finally {
      try { await noRootsClient.close(); } catch { /* ignore */ }
      try { await transport.close(); } catch { /* ignore */ }
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 30_000);

  it("S5 — server returns instructions on initialize: routing table + anti-bypass directive, under 2KB", async () => {
    const conn = makeClient();
    client = conn.client;
    transport = conn.transport;
    await client.connect(transport);

    const instructions = client.getInstructions();
    expect(instructions, "server instructions are missing — client received none on initialize").toBeDefined();
    const text = instructions!;
    // Stay under the Claude Code 2KB truncation budget with headroom
    expect(text.length).toBeLessThan(2048);
    expect(text.length).toBeGreaterThan(500);
    // Critical guidance must be front-loaded (within the first ~400 chars)
    expect(text.slice(0, 600)).toMatch(/MUST call the appropriate cedar_\* tool/);
    // Routing table includes cedar_advise as the first-call directive for change planning
    expect(text).toMatch(/cedar_advise FIRST/);
    // Anti-bypass directive present
    expect(text).toMatch(/Do NOT use Read or Bash to inspect Cedar policy semantics/);
    // 10d: workspace auto-discovery directive present
    expect(text).toMatch(/Workspace auto-discovery/);
    expect(text).toMatch(/retry with the field omitted/);
  }, 15_000);
});
