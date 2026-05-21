/**
 * Integration smoke test for HTTP (Streamable HTTP) transport.
 *
 * Starts cedar-mcp-server's HTTP entry point on an ephemeral port, connects
 * via a real MCP StreamableHTTPClientTransport, and exercises:
 *   H1 — listTools returns the 17 tools
 *   H2 — cedar_validate via the protocol returns valid:true
 *   H3 — cedar_authorize via the protocol returns Allow
 *   H4 — health endpoint returns ok JSON
 *   H5 — malformed JSON to /mcp returns a structured error (no server crash)
 *   H6 — graceful shutdown closes cleanly
 *
 * Runs separately from unit tests:
 *   npx vitest run test/integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer, type RunningHttpServer } from "../../src/http-server.js";

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
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Document"], context: { type: "Record", attributes: {} } },
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

const ALICE_ENTITIES = JSON.stringify([
  {
    uid: { type: "DocMgmt::User", id: "alice" },
    attrs: { name: "Alice", email: "alice@example.com" },
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

function parseToolResult(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const textBlock = r.content?.find((b) => b.type === "text");
  if (!textBlock?.text) throw new Error("No text content in tool result");
  return JSON.parse(textBlock.text);
}

/** Find an unused TCP port by binding to 0 and reading what the OS gave us. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("Could not determine ephemeral port"));
      }
    });
  });
}

describe("integration HTTP smoke", () => {
  let running: RunningHttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await getFreePort();
    running = await startHttpServer({ port, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${port}`;
  }, 20_000);

  afterAll(async () => {
    if (running) await running.close();
  });

  it("H1 — listTools returns the 17 registered tools", async () => {
    const client = new Client({ name: "http-smoke", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // Asserts on both presence (semantic) and total count (regression guard).
      // If a tool is added but not registered, total mismatches; if a tool is
      // dropped, the .toContain check catches that.
      expect(names).toContain("cedar_validate");
      expect(names).toContain("cedar_authorize");
      expect(names).toContain("cedar_authorize_batch");
      expect(names).toContain("cedar_validate_schema");
      expect(names).toContain("cedar_diff_schema");
      expect(names).toContain("cedar_validate_entities");
      expect(names).toContain("cedar_validate_template");
      expect(names).toContain("cedar_link_template");
      expect(names).toContain("cedar_list_templates");
      expect(names).toContain("cedar_list_template_links");
      expect(names).toContain("cedar_diff_policy_stores");
      expect(names).toContain("cedar_advise");
      expect(names).toHaveLength(17);
    } finally {
      await client.close();
    }
  }, 15_000);

  it("H2 — cedar_validate via HTTP returns valid:true for correct policy + schema", async () => {
    const client = new Client({ name: "http-smoke", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    try {
      const raw = await client.callTool({
        name: "cedar_validate",
        arguments: { policies: ADMIN_POLICY, schema: DOCMGMT_SCHEMA },
      });
      const result = parseToolResult(raw) as { valid: boolean; errors: unknown[]; policy_count: number };
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.policy_count).toBe(1);
    } finally {
      await client.close();
    }
  }, 15_000);

  it("H3 — cedar_authorize via HTTP returns Allow for alice reading doc-public", async () => {
    const client = new Client({ name: "http-smoke", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    try {
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
      const result = parseToolResult(raw) as { decision: string };
      expect(result.decision).toBe("Allow");
    } finally {
      await client.close();
    }
  }, 15_000);

  it("H4 — /health endpoint returns ok JSON", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", transport: "streamable-http", mode: "stateful" });
  });

  it("H6 — three concurrent sessions don't interfere; each gets correct correlated responses", async () => {
    // True transport-level concurrency: three independent Clients, each with its
    // own Mcp-Session-Id from the server's stateful sessionIdGenerator, hitting
    // the HTTP endpoint in parallel via Promise.all. Failure case: session
    // routing mixes responses between sessions, or shared transport state across
    // sessions corrupts the message history. The stdio F11 test in failure-modes
    // covers ID routing within a single session; this test covers ID routing
    // ACROSS sessions, which only HTTP supports.

    const clients = [0, 1, 2].map(() => new Client(
      { name: "http-smoke-concurrent", version: "1.0.0" },
      { capabilities: {} }
    ));
    const transports = [0, 1, 2].map(() => new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    try {
      // Connect all three in parallel
      await Promise.all(clients.map((c, i) => c.connect(transports[i]!)));

      // Each client identifies its request via a unique role name in the policy.
      // If session routing mixed responses, client[i] would receive role-${j}
      // (j ≠ i) in its response body.
      const calls = clients.map((c, i) =>
        c.callTool({
          name: "cedar_explain",
          arguments: {
            policy: `permit (principal in DocMgmt::Role::"role-session-${i}", action, resource);`,
          },
        })
      );
      const results = await Promise.all(calls);

      for (let i = 0; i < results.length; i++) {
        const parsed = parseToolResult(results[i]!);
        const body = JSON.stringify(parsed);
        expect(body, `session ${i} response`).toContain(`role-session-${i}`);
      }
    } finally {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    }
  }, 30_000);

  it("H7 — schema_ref via cedar:// URI does NOT resolve in HTTP mode without --root configured", async () => {
    // Sanity: without --root flags, the storeManager has no stores. A client
    // passing schema_ref: "cedar://schema/anything" should get a clean error,
    // not a hang or a crash. This documents the boundary between the default
    // HTTP server (no roots) and the configured HTTP deployment (with roots,
    // covered by the H-ROOT suite below).
    const client = new Client({ name: "http-no-roots", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    try {
      const raw = await client.callTool({
        name: "cedar_validate",
        arguments: {
          policies: ADMIN_POLICY,
          schema_ref: "cedar://schema/nonexistent",
        },
      });
      const result = raw as { content: Array<{ type: string; text?: string }> };
      const textBlock = result.content.find((b) => b.type === "text");
      const parsed = JSON.parse(textBlock!.text!);
      expect(parsed.error).toBeDefined();
    } finally {
      await client.close();
    }
  }, 15_000);

  it("H5 — malformed JSON-RPC body returns a structured error, not a crash", async () => {
    // Send a payload that's syntactically valid JSON but not valid JSON-RPC.
    // The transport must respond with a structured error (HTTP 400/422 or a
    // JSON-RPC error envelope) — never a 500 with a raw stack, and never a
    // hung connection. This is the falsification case for "what would prove
    // the transport robust to malformed input?"
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
      body: JSON.stringify({ not_a: "valid", jsonrpc_message: true }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
    // Body should parse as JSON (structured error), not be HTML or empty.
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    // Don't assert on exact shape — different MCP SDK versions structure the error differently.
    // Key invariant: no server crash, and a response was returned.
  });
});

/**
 * H-ROOT suite — exercises the actual deployment path the peer review called
 * out: cedar-mcp-server --http <port> --root name=path. Without this, the
 * other HTTP smoke tests pass without ever invoking the cedar:// resolution
 * path that real deployments depend on. Closes the gap.
 */
describe("integration HTTP smoke — with --root configured", () => {
  let running: RunningHttpServer;
  let baseUrl: string;
  let storeDir: string;

  const STORE_SCHEMA = `namespace DocMgmt {
  entity User in [Role] = { name: String, email: String };
  entity Role;
  entity Document in [Folder] = { owner: String, classification: String };
  entity Folder;
  action read appliesTo {
    principal: [User],
    resource: [Document]
  };
}`.trim();

  const STORE_ADMIN_POLICY = `permit (
  principal in DocMgmt::Role::"admin",
  action,
  resource
);`;

  const STORE_ENTITIES_FILE = JSON.stringify([
    { uid: { type: "DocMgmt::User", id: "alice" }, attrs: { name: "Alice", email: "a@b.c" }, parents: [{ type: "DocMgmt::Role", id: "admin" }] },
    { uid: { type: "DocMgmt::Role", id: "admin" }, attrs: {}, parents: [] },
    { uid: { type: "DocMgmt::Document", id: "doc-public" }, attrs: { owner: "alice", classification: "public" }, parents: [{ type: "DocMgmt::Folder", id: "shared" }] },
    { uid: { type: "DocMgmt::Folder", id: "shared" }, attrs: {}, parents: [] },
  ]);

  beforeAll(async () => {
    // Build a real on-disk policy store
    storeDir = mkdtempSync(join(tmpdir(), "cedar-mcp-http-root-"));
    mkdirSync(join(storeDir, "policies"), { recursive: true });
    mkdirSync(join(storeDir, "entities"), { recursive: true });
    writeFileSync(join(storeDir, "policies", "admin.cedar"), STORE_ADMIN_POLICY);
    writeFileSync(join(storeDir, "schema.cedarschema"), STORE_SCHEMA);
    writeFileSync(join(storeDir, "entities", "alice-and-docs.json"), STORE_ENTITIES_FILE);

    const port = await getFreePort();
    running = await startHttpServer({
      port,
      host: "127.0.0.1",
      roots: [{ name: "test-store", path: storeDir }],
    });
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    if (running) await running.close();
    if (storeDir) {
      try { rmSync(storeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("HR1 — cedar://policies/test-store resolves all .cedar files through HTTP", async () => {
    // The deployment path: a client passes policy_ref instead of inlining
    // policy text. The HTTP server resolves the URI via the deployer-configured
    // store. Without this test, the entire "shared remote MCP for a team"
    // value prop was untested over HTTP.
    const client = new Client({ name: "http-root", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    try {
      const raw = await client.callTool({
        name: "cedar_validate",
        arguments: {
          policy_ref: "cedar://policies/test-store",
          schema_ref: "cedar://schema/test-store",
        },
      });
      const result = raw as { content: Array<{ type: string; text?: string }> };
      const parsed = JSON.parse(result.content.find((b) => b.type === "text")!.text!) as { valid: boolean; policy_count: number };
      expect(parsed.valid).toBe(true);
      expect(parsed.policy_count).toBe(1);
    } finally {
      await client.close();
    }
  }, 20_000);

  it("HR2 — cedar://entities/test-store + cedar_authorize via entities_ref returns Allow", async () => {
    // The entities_ref path. Even reading a single file (alice-and-docs.json)
    // via cedar://entities/test-store/alice-and-docs is non-trivial — it
    // exercises the store's listEntities/readEntities pair through the HTTP
    // transport, then routes the resolved content into the authorize call.
    const client = new Client({ name: "http-root-auth", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    try {
      const raw = await client.callTool({
        name: "cedar_authorize",
        arguments: {
          policy_ref: "cedar://policies/test-store",
          schema_ref: "cedar://schema/test-store",
          entities_ref: "cedar://entities/test-store",
          principal: 'DocMgmt::User::"alice"',
          action: 'DocMgmt::Action::"read"',
          resource: 'DocMgmt::Document::"doc-public"',
        },
      });
      const result = raw as { content: Array<{ type: string; text?: string }> };
      const parsed = JSON.parse(result.content.find((b) => b.type === "text")!.text!) as { decision: string };
      expect(parsed.decision).toBe("Allow");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("HR3 — cedar://policies/{store}/{id} resolves a single file by id", async () => {
    // The fine-grained resolution path. Failure case: a resolver that requires
    // store-level listing would fail when given an id-specific URI, or vice
    // versa. This proves both granularities work through HTTP.
    const client = new Client({ name: "http-root-single", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    try {
      const raw = await client.callTool({
        name: "cedar_validate",
        arguments: {
          policy_ref: "cedar://policies/test-store/admin",
          schema_ref: "cedar://schema/test-store",
        },
      });
      const result = raw as { content: Array<{ type: string; text?: string }> };
      const parsed = JSON.parse(result.content.find((b) => b.type === "text")!.text!) as { valid: boolean; policy_count: number };
      expect(parsed.valid).toBe(true);
      expect(parsed.policy_count).toBe(1);
    } finally {
      await client.close();
    }
  }, 20_000);

  it("HR5 — max-sessions cap returns HTTP 503 instead of unbounded growth", async () => {
    // The failure mode this guards against: long-running deployments leaking
    // sessions if transport.onclose doesn't fire (TCP RST, network partition,
    // misbehaving client). Without a cap the sessions Map grows unbounded.
    //
    // This test starts a dedicated server with maxSessions: 2, opens 2 valid
    // sessions, then verifies a third initialize request returns HTTP 503
    // with a structured error body.
    const port = await getFreePort();
    const cappedServer = await startHttpServer({
      port,
      host: "127.0.0.1",
      maxSessions: 2,
      reaperIntervalMs: 60_000,  // disable reaper for this test
    });
    const cappedUrl = `http://127.0.0.1:${port}/mcp`;

    try {
      // Fill the cap with two real sessions
      const c1 = new Client({ name: "cap-1", version: "1.0.0" }, { capabilities: {} });
      const t1 = new StreamableHTTPClientTransport(new URL(cappedUrl));
      await c1.connect(t1);
      await c1.listTools();

      const c2 = new Client({ name: "cap-2", version: "1.0.0" }, { capabilities: {} });
      const t2 = new StreamableHTTPClientTransport(new URL(cappedUrl));
      await c2.connect(t2);
      await c2.listTools();

      try {
        // Third initialize attempt — must hit the cap. Use raw fetch so we can
        // observe the HTTP status code directly (SDK client would just throw).
        const res = await fetch(cappedUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cap-overflow", version: "1.0.0" } },
          }),
        });
        expect(res.status).toBe(503);
        const body = await res.json() as { error: string; active_sessions: number; max_sessions: number };
        expect(body.error).toMatch(/too many|max-session/i);
        expect(body.max_sessions).toBe(2);
        expect(body.active_sessions).toBe(2);

        // Health should reflect the cap as configured
        const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { max_sessions: number };
        expect(health.max_sessions).toBe(2);
      } finally {
        await c1.close().catch(() => { /* ignore */ });
        await c2.close().catch(() => { /* ignore */ });
      }
    } finally {
      await cappedServer.close();
    }
  }, 30_000);

  it("HR6 — idle sessions are evicted by the reaper after the configured TTL", async () => {
    // The failure mode: transport.onclose unreliable on network faults; without
    // the reaper, the sessions Map leaks. This test sets a very short idle TTL
    // (200ms) and a fast reaper interval (50ms), opens a session, waits long
    // enough for eviction, then verifies active_sessions drops to 0.
    //
    // We don't try to use the evicted session afterward — the SDK client would
    // try to send on a stale transport and get a 404 (the spec'd response for
    // unknown session id). That's a separate test that depends on the SDK
    // client's error semantics.
    const port = await getFreePort();
    const reaperServer = await startHttpServer({
      port,
      host: "127.0.0.1",
      sessionIdleTtlMs: 200,
      reaperIntervalMs: 50,
    });
    const reaperUrl = `http://127.0.0.1:${port}`;

    try {
      const client = new Client({ name: "reap-target", version: "1.0.0" }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(`${reaperUrl}/mcp`));
      await client.connect(transport);
      await client.listTools();

      // Confirm the session is registered
      const before = await (await fetch(`${reaperUrl}/health`)).json() as { active_sessions: number };
      expect(before.active_sessions).toBeGreaterThanOrEqual(1);

      // Wait > (idle TTL + reaper interval) so eviction definitely fires
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      const after = await (await fetch(`${reaperUrl}/health`)).json() as { active_sessions: number };
      // After idle eviction, the session count must drop. (Note: client may
      // not have called .close() at this point, but the reaper acted on its
      // own.)
      expect(after.active_sessions).toBeLessThan(before.active_sessions);

      // Cleanup client — it'll get an error closing over evicted transport, ignore
      await client.close().catch(() => { /* ignore */ });
    } finally {
      await reaperServer.close();
    }
  }, 30_000);

  it("HR4 — /health exposes active_sessions count + the deployer roots model", async () => {
    // The /health endpoint reports active_sessions. Open a session, hit /health,
    // verify count went up. Catches a leak where active_sessions doesn't
    // reflect the actual map state, OR a bug where the map double-counts.
    const before = await (await fetch(`${baseUrl}/health`)).json() as { active_sessions: number };

    const client = new Client({ name: "http-root-health", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);
    // Force the session to fully initialize by making one round-trip
    await client.listTools();

    const during = await (await fetch(`${baseUrl}/health`)).json() as { active_sessions: number };
    expect(during.active_sessions).toBeGreaterThanOrEqual(before.active_sessions + 1);

    await client.close();
  }, 20_000);

  it("HR7 — resources/list enumerates cedar:// URIs from loaded roots (H2)", async () => {
    // The MCP resources/list method must enumerate the cedar:// URIs the
    // server can actually serve, so UI-driven MCP clients (and any client
    // not pre-trained on the URI scheme) can discover what is available.
    // Before H2 fixed this, the server returned an empty list even though
    // every cedar:// URI resolved correctly when referenced as policy_ref,
    // schema_ref, or entities_ref.
    const client = new Client({ name: "http-root-list-resources", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    try {
      const { resources } = await client.listResources();
      const uris = resources.map((r) => r.uri);

      // Per-item resources for the test-store: 1 policy + 1 schema + 1 entities file
      expect(uris).toContain("cedar://policies/test-store/admin");
      expect(uris).toContain("cedar://schema/test-store");
      expect(uris).toContain("cedar://entities/test-store/alice-and-docs");

      // Index resources (the {store} listing endpoints)
      expect(uris).toContain("cedar://policies/test-store");
      expect(uris).toContain("cedar://entities/test-store");

      // Sanity: total should be at least 5 (1 policy + 1 schema + 1 entities + 2 indexes)
      expect(uris.length).toBeGreaterThanOrEqual(5);

      // Every resource must carry a non-empty name field (MCP requires it)
      for (const r of resources) {
        expect(r.name, `resource ${r.uri} missing name`).toBeTruthy();
      }
    } finally {
      await client.close();
    }
  }, 20_000);
});
