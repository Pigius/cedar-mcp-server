import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";
import { storeManager } from "./resources/store-manager.js";

async function loadRoots(server: Awaited<ReturnType<typeof createServer>>) {
  try {
    const result = await server.server.listRoots();
    storeManager.loadFromRoots(result.roots);
  } catch {
    // Client may not support roots — proceed with empty store list
  }
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Load roots after the MCP handshake completes (oninitialized fires on the
  // low-level Server after the client sends the initialized notification)
  server.server.oninitialized = async () => {
    await loadRoots(server);
  };

  // Re-load roots whenever the client signals the root list changed
  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => { await loadRoots(server); }
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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
