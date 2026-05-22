import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createServer } from "./server.js";
import { storeManager } from "./resources/store-manager.js";
import { startHttpServer } from "./http-server.js";

/**
 * A directory "looks like a Cedar workspace" if it has at least one of:
 *   - schema.cedarschema  (preferred)
 *   - schema.json         (fallback)
 *   - policies/           (per-file policies layout)
 *
 * This is the same convention StoreManager uses to read a loaded root.
 */
function looksLikeCedarWorkspace(path: string): boolean {
  return (
    existsSync(join(path, "schema.cedarschema")) ||
    existsSync(join(path, "schema.json")) ||
    existsSync(join(path, "policies"))
  );
}

/**
 * Synchronously populate StoreManager with the cwd-fallback store, if the
 * cwd looks like a Cedar workspace. Returns the loaded root descriptor when
 * a store was loaded, or null otherwise.
 *
 * Round 5 dogfood (Scenario E) found that emitting `notifications/resources/list_changed`
 * AFTER an async cwd-fallback (kickoff-11 11a) was insufficient: Claude Code's
 * `listMcpResources` does not honor `list_changed` for cache invalidation, so a
 * client that snapshots `resources/list` once on the initialize response stays
 * stuck on the empty pre-fallback snapshot regardless of any later notification.
 *
 * The fix is structural: populate StoreManager BEFORE the transport accepts
 * any client requests. `process.cwd()` is available at startup; there is no
 * need to wait for the transport. By the time the client can send any
 * request, the store already exists.
 *
 * Security: rejects filesystem-root cwds (`/`) and any cwd whose basename is
 * empty after normalization. Without this guard, the cwd-fallback would push
 * an empty-path root into StoreManager, and the per-store path sandbox
 * (`isPathAllowed`, which uses `startsWith(store.path)`) would return true
 * for every filesystem path. StoreManager.loadFromRoots also refuses
 * empty-path roots as a second layer of defense, but rejecting here keeps
 * the cwd-fallback's intent narrow (workspace-shaped cwds only).
 *
 * Exported so unit tests can exercise it without spawning a stdio process.
 */
export function populateCwdFallback(cwd: string): { uri: string; name: string } | null {
  if (cwd === "/" || basename(cwd).length === 0) return null;
  if (!looksLikeCedarWorkspace(cwd)) return null;
  const cwdRoot = { uri: `file://${cwd}`, name: basename(cwd) };
  storeManager.loadFromRoots([cwdRoot]);
  return cwdRoot;
}

interface ParsedArgs {
  mode: "stdio" | "http" | "help";
  port?: number;
  host?: string;
  roots: Array<{ name: string; path: string }>;
  error?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const out: ParsedArgs = { mode: "stdio", roots: [] };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") {
      return { mode: "help", roots: [] };
    } else if (a === "--http") {
      const portArg = args[i + 1];
      if (!portArg || portArg.startsWith("--")) {
        return { mode: "help", roots: [], error: "--http requires a port number (e.g. --http 3000)" };
      }
      const port = Number(portArg);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { mode: "help", roots: [], error: `--http port must be an integer between 1 and 65535 (got '${portArg}')` };
      }
      out.mode = "http";
      out.port = port;
      i++;
    } else if (a === "--host") {
      const hostArg = args[i + 1];
      if (!hostArg || hostArg.startsWith("--")) {
        return { mode: "help", roots: [], error: "--host requires a hostname (e.g. --host 0.0.0.0)" };
      }
      out.host = hostArg;
      i++;
    } else if (a === "--root") {
      const rootArg = args[i + 1];
      if (!rootArg || rootArg.startsWith("--")) {
        return { mode: "help", roots: [], error: "--root requires a name=path value (e.g. --root production=/etc/cedar/prod)" };
      }
      const eq = rootArg.indexOf("=");
      if (eq <= 0 || eq === rootArg.length - 1) {
        return { mode: "help", roots: [], error: `--root must be name=path (got '${rootArg}')` };
      }
      const name = rootArg.slice(0, eq);
      const path = rootArg.slice(eq + 1);
      out.roots.push({ name, path });
      i++;
    } else {
      return { mode: "help", roots: [], error: `Unknown argument: ${a}` };
    }
  }

  if (out.mode === "stdio" && out.roots.length > 0) {
    return { mode: "help", roots: [], error: "--root flags are only used with --http mode; in stdio mode roots come from the MCP client" };
  }

  return out;
}

function printUsage(error?: string): void {
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${error}\n`);
  }
  // eslint-disable-next-line no-console
  console.error(
    `cedar-mcp-server — MCP server for Cedar policy language

Usage:
  cedar-mcp-server                              Start in stdio mode (default; for npx/Claude Code)
  cedar-mcp-server --http <port> [options]      Start in Streamable HTTP mode for shared team deployment

HTTP options:
  --http <port>            Listen port (1-65535)
  --host <host>            Bind host (default: 127.0.0.1; use 0.0.0.0 for non-localhost; you handle auth via reverse proxy)
  --root <name>=<path>     Repeatable; deployer-configured policy store ("production=/etc/cedar/prod")

Notes:
  - Stdio mode: roots are negotiated with the MCP client via listRoots(); --root flags are not allowed.
  - HTTP mode: stateful Streamable HTTP transport with session IDs. ALL clients share the same roots and policy stores (deployment model: one server per policy-store set). For per-tenant isolation, run multiple processes.
  - HTTP mode default-binds to localhost with DNS-rebinding protection. Non-localhost binding is on you to secure (reverse proxy + auth).

Examples:
  cedar-mcp-server
  cedar-mcp-server --http 3000 --root production=/etc/cedar/production --root staging=/etc/cedar/staging
  cedar-mcp-server --http 3000 --host 0.0.0.0 --root prod=/etc/cedar/prod
`
  );
}

/**
 * Reconcile StoreManager state with whatever the MCP client advertises via
 * `listRoots()`. Called from `oninitialized` AND on every
 * `notifications/roots/list_changed` from the client.
 *
 * Precedence rules:
 *  - Client-advertised roots REPLACE any sync-loaded cwd-fallback. A client
 *    that explicitly advertises roots is stating authoritative intent; the
 *    cwd-fallback was an "if you didn't tell me anything" default.
 *  - Client returns ZERO roots (or doesn't support listRoots): preserve the
 *    sync-loaded cwd-fallback. We do NOT call `loadFromRoots([])` here
 *    because StoreManager.loadFromRoots clears the store as its first step,
 *    which would wipe the cwd-fallback populated synchronously at startup.
 *
 * `sendResourceListChanged` always fires at the end: cache-aware clients use
 * it to refetch when the store membership changes. Idempotent if nothing
 * actually changed.
 */
async function loadRootsStdio(server: Awaited<ReturnType<typeof createServer>>) {
  let clientRoots: Array<{ uri: string; name?: string }> = [];
  let clientSupportsRoots = true;
  try {
    const result = await server.server.listRoots();
    clientRoots = result.roots;
  } catch {
    clientSupportsRoots = false;
  }

  // Reconcile StoreManager state from the current (clientRoots, cwd) tuple.
  // Stateless re-derivation: each call to loadRootsStdio computes the right
  // state from scratch rather than mutating the previous state. This matters
  // when a client advertised roots earlier and then retracts them via
  // `roots/list_changed`; without re-derivation the stale advertised roots
  // would leak forward instead of falling back to cwd.
  if (clientRoots.length > 0) {
    storeManager.loadFromRoots(clientRoots);
    console.error(`[cedar-mcp-server] Loaded ${clientRoots.length} root(s) from MCP client: ${clientRoots.map((r) => r.uri).join(", ")} (replaces any sync-loaded cwd-fallback).`);
  } else {
    const fallback = populateCwdFallback(process.cwd());
    if (fallback) {
      console.error(`[cedar-mcp-server] MCP client advertised 0 roots; using cwd-fallback store "${fallback.name}" (re-derived).`);
    } else {
      storeManager.loadFromRoots([]);
      if (clientSupportsRoots) {
        console.error("[cedar-mcp-server] MCP client returned 0 roots and cwd does not look like a Cedar workspace (no schema.cedarschema, schema.json, or policies/ dir). Cedar tools will require inline inputs.");
      } else {
        console.error("[cedar-mcp-server] MCP client does not support roots/list and cwd does not look like a Cedar workspace. Cedar tools will require inline inputs.");
      }
    }
  }

  // kickoff-11 11a notification: cache-aware clients refetch on this. The
  // synchronous cwd-fallback from runStdio means the FIRST resources/list
  // already sees the populated store (this is the Round 5 fix), so this
  // notification is most useful for the late-arriving-roots case (client
  // sends roots/list_changed mid-session, swapping the store set). McpServer
  // makes it a no-op when not connected, so it's safe to call from any path.
  server.sendResourceListChanged();
}

async function runStdio(): Promise<void> {
  const server = createServer();

  // Round 5 fix: populate StoreManager BEFORE the transport accepts any
  // client requests. The previous shape (cwd-fallback inside `oninitialized`
  // → kickoff-11 sendResourceListChanged) was contract-correct against the
  // MCP spec but did not hold against Claude Code, which snapshots
  // resources/list once on the initialize response and does not honor
  // list_changed for the `listMcpResources` cache. Synchronous population
  // before connect closes the window entirely.
  //
  // Edge case (kickoff-10 audit Probe C): if process.cwd() is the
  // cedar-mcp-server repo itself, it currently has none of schema.cedarschema,
  // schema.json, or policies/ — looksLikeCedarWorkspace returns false. If a
  // future commit adds a top-level policies/ directory (for examples or
  // similar) the fallback would self-load. Flag in CHANGELOG if that
  // ever happens.
  const loaded = populateCwdFallback(process.cwd());
  if (loaded) {
    console.error(`[cedar-mcp-server] Synchronously auto-loaded cwd as workspace store: "${loaded.name}" (${loaded.uri}). StoreManager populated before transport accepts requests.`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  server.server.oninitialized = async () => {
    await loadRootsStdio(server);
  };

  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => {
      await loadRootsStdio(server);
    }
  );

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });
}

async function runHttp(parsed: ParsedArgs): Promise<void> {
  const running = await startHttpServer({
    port: parsed.port!,
    host: parsed.host,
    roots: parsed.roots,
  });

  const shutdown = async () => {
    try {
      await running.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if (parsed.mode === "help") {
    printUsage(parsed.error);
    process.exit(parsed.error ? 1 : 0);
  }
  if (parsed.mode === "http") {
    await runHttp(parsed);
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error:", err);
  process.exit(1);
});
