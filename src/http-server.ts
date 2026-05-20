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
}

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
 * Session lifecycle:
 *   1. Client POSTs to /mcp without Mcp-Session-Id → server creates a new
 *      session (transport + server pair), runs initialize, returns the
 *      session ID in the response header.
 *   2. Subsequent requests with that Mcp-Session-Id route to the same pair.
 *   3. transport.onclose fires on disconnect → session is removed from the map.
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const host = options.host ?? "127.0.0.1";

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

    return { transport, server };
  }

  const app = createMcpExpressApp({ host });
  app.use(express.json({ limit: "10mb" }));

  app.post("/mcp", async (req, res) => {
    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      let session: Session | undefined;
      if (sessionId && sessions.has(sessionId)) {
        session = sessions.get(sessionId);
      } else {
        // New session — initialize and register after handleRequest assigns the session ID
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
  console.error(`[cedar-mcp-server] Streamable HTTP listening on http://${host}:${options.port}/mcp`);
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
