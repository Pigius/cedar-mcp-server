import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";
import { storeManager } from "./resources/store-manager.js";
import { startHttpServer } from "./http-server.js";

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

async function loadRootsStdio(server: Awaited<ReturnType<typeof createServer>>) {
  try {
    const result = await server.server.listRoots();
    storeManager.loadFromRoots(result.roots);
  } catch {
    // Client may not support roots — proceed with empty store list
  }
}

async function runStdio(): Promise<void> {
  const server = createServer();
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
