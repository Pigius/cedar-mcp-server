import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express from "express";
import { createServer } from "./server.js";
import { storeManager } from "./resources/store-manager.js";

export interface HttpServerOptions {
  port: number;
  host?: string;
  roots?: Array<{ name: string; path: string }>;
  /** Max concurrent HTTP sessions. New sessions over the cap receive 503.
   *  Default: 100. Override via env CEDAR_MAX_HTTP_SESSIONS or this option. */
  maxSessions?: number;
  /** Idle session TTL in milliseconds. A session unused for longer is evicted
   *  by the reaper. Default: 30 minutes. Override via env
   *  CEDAR_HTTP_SESSION_IDLE_TTL_MS or this option. */
  sessionIdleTtlMs?: number;
  /** How often the reaper scans for stale sessions. Default: 60 seconds.
   *  Mostly relevant for tests; production deploys can leave the default. */
  reaperIntervalMs?: number;
}

export interface RunningHttpServer {
  httpServer: HttpServer;
  port: number;
  host: string;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Awaited<ReturnType<typeof createServer>>;
  /** Wall-clock timestamp of the last request observed on this session.
   *  Used by the reaper to evict idle sessions. */
  lastActiveAt: number;
}

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_REAPER_INTERVAL_MS = 60 * 1000;       // 1 min

/**
 * Boot cedar-mcp-server in Streamable HTTP mode.
 *
 * Per-session model: each MCP session gets its own McpServer + transport pair.
 * The Streamable HTTP spec mandates this because each session has independent
 * protocol state (initialized handshake, message history, capabilities).
 *
 * Shared across all sessions: the storeManager singleton. The deployment model
 * is "one server per policy-store set, many team clients all seeing the same
 * roots." Roots are deployer-configured via CLI flags at startup; client
 * listRoots() is NOT called in HTTP mode. For per-tenant isolation, deploy
 * multiple processes.
 *
 * Resource management:
 *   - Max-sessions cap: new sessions over the limit receive HTTP 503. This is
 *     backpressure, not eviction — existing sessions are not interrupted to
 *     make room. Default 100; override via maxSessions option or
 *     CEDAR_MAX_HTTP_SESSIONS env var.
 *   - Idle TTL: a reaper scans periodically and evicts sessions whose last
 *     observed request exceeds the TTL. Default 30 min idle / 60s scan;
 *     override via sessionIdleTtlMs / reaperIntervalMs options or env vars.
 *     This catches the case where transport.onclose doesn't fire (e.g.,
 *     network partition, TCP RST) and prevents the sessions map from leaking.
 *
 * Session lifecycle:
 *   1. Client POSTs to /mcp without Mcp-Session-Id → server creates a new
 *      session (transport + server pair), runs initialize, returns the
 *      session ID in the response header. New sessions over maxSessions are
 *      rejected with HTTP 503.
 *   2. Subsequent requests with that Mcp-Session-Id route to the same pair
 *      and refresh its lastActiveAt timestamp.
 *   3. transport.onclose fires on graceful disconnect → session removed.
 *   4. Reaper sweeps idle sessions out periodically as a backstop.
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const maxSessions = options.maxSessions
    ?? (Number(process.env.CEDAR_MAX_HTTP_SESSIONS) || DEFAULT_MAX_SESSIONS);
  const sessionIdleTtlMs = options.sessionIdleTtlMs
    ?? (Number(process.env.CEDAR_HTTP_SESSION_IDLE_TTL_MS) || DEFAULT_SESSION_IDLE_TTL_MS);
  const reaperIntervalMs = options.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS;

  // Load deployer-configured roots before the server starts accepting traffic.
  // Shared by all sessions via the storeManager singleton.
  if (options.roots && options.roots.length > 0) {
    storeManager.loadFromRoots(
      options.roots.map((r) => ({ uri: `file://${r.path}`, name: r.name }))
    );
  }

  const sessions = new Map<string, Session>();

  async function createSession(): Promise<Session> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const server = createServer();
    await server.connect(transport);

    transport.onclose = () => {
      // Only drop the session-map entry here. Do NOT call server.close():
      // server.close() triggers transport close, which fires this handler
      // again. The McpServer becomes unreferenced and gets GC'd. The shared
      // WASM module lives at process scope, not per-session.
      const sid = transport.sessionId;
      if (sid && sessions.has(sid)) {
        sessions.delete(sid);
      }
    };

    return { transport, server, lastActiveAt: Date.now() };
  }

  // Reaper: evict sessions whose lastActiveAt is older than the idle TTL.
  // Collect-then-delete pattern avoids mid-iteration map mutation when the
  // transport.close() callback re-enters the sessions map.
  const reaper = setInterval(() => {
    const cutoff = Date.now() - sessionIdleTtlMs;
    const toEvict: string[] = [];
    for (const [sid, sess] of sessions.entries()) {
      if (sess.lastActiveAt < cutoff) toEvict.push(sid);
    }
    for (const sid of toEvict) {
      const sess = sessions.get(sid);
      if (sess) {
        sessions.delete(sid);
        void sess.transport.close().catch(() => { /* ignore */ });
      }
    }
  }, reaperIntervalMs);
  // Don't keep the Node event loop alive just for the reaper — let the
  // process exit cleanly when the HTTP server closes.
  reaper.unref();

  const app = createMcpExpressApp({ host });
  app.use(express.json({ limit: "10mb" }));

  app.post("/mcp", async (req, res) => {
    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      let session: Session | undefined;
      if (sessionId && sessions.has(sessionId)) {
        session = sessions.get(sessionId);
        if (session) session.lastActiveAt = Date.now();
      } else {
        // New session — apply backpressure if at cap. We do this BEFORE
        // creating the transport/server pair to avoid leaking resources
        // on rejection.
        if (sessions.size >= maxSessions) {
          res.status(503).json({
            error: "Too many concurrent MCP sessions",
            message: `Server is at the max-session limit of ${maxSessions}. Try again later, or run multiple processes for higher capacity.`,
            active_sessions: sessions.size,
            max_sessions: maxSessions,
          });
          return;
        }
        session = await createSession();
      }

      if (!session) {
        res.status(400).json({ error: "Could not establish MCP session" });
        return;
      }

      await session.transport.handleRequest(req, res, req.body);

      // After the initialize request completes the transport will have set
      // its sessionId. Register the session under that ID so subsequent
      // requests find it.
      const sidAfter = session.transport.sessionId;
      if (sidAfter && !sessions.has(sidAfter)) {
        sessions.set(sidAfter, session);
      }
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal MCP transport error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      transport: "streamable-http",
      mode: "stateful",
      active_sessions: sessions.size,
      max_sessions: maxSessions,
      session_idle_ttl_ms: sessionIdleTtlMs,
    });
  });

  const httpServer = createHttpServer(app);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  // eslint-disable-next-line no-console
  console.error(`[cedar-mcp-server] Streamable HTTP listening on http://${host}:${options.port}/mcp (max_sessions=${maxSessions}, idle_ttl=${Math.round(sessionIdleTtlMs / 1000)}s)`);
  if (options.roots && options.roots.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[cedar-mcp-server] Loaded ${options.roots.length} root(s): ${options.roots.map((r) => r.name).join(", ")}`);
  } else {
    // eslint-disable-next-line no-console
    console.error("[cedar-mcp-server] WARNING: no --root flags supplied; tools that depend on a configured store will error.");
  }

  return {
    httpServer,
    port: options.port,
    host,
    async close() {
      clearInterval(reaper);
      // Close all sessions first so each McpServer cleans up its WASM state
      for (const session of sessions.values()) {
        try {
          await session.server.close();
        } catch { /* ignore */ }
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
