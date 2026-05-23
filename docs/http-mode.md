# Running as a shared HTTP server

The default `npx cedar-mcp-server` mode is stdio, designed for Claude Code / Claude Desktop / Cursor on a single developer machine. For a shared team deployment (one server, many clients), use Streamable HTTP mode.

### Start the server

```bash
# Local-only (recommended default; binds to 127.0.0.1 with DNS rebinding protection)
cedar-mcp-server --http 3000 --root production=/etc/cedar/production --root staging=/etc/cedar/staging

# Non-localhost binding (you handle auth via reverse proxy)
cedar-mcp-server --http 3000 --host 0.0.0.0 --root prod=/etc/cedar/prod
```

CLI flags:

| Flag | Required | Description |
|------|----------|-------------|
| `--http <port>` | yes (HTTP mode) | Listen port (1-65535) |
| `--host <host>` | no | Bind host (default `127.0.0.1`) |
| `--root <name>=<path>` | repeatable | Deployer-configured policy store; clients see these as MCP Roots |
| `--help` | no | Print usage |

### Roots in stdio vs HTTP mode

In stdio mode, your MCP client advertises its workspace folders to the server automatically via the `listRoots()` protocol. You do not need the `--root` flag at all; the server queries the client on initialize and loads each advertised root as a named policy store. If you pass `--root` to the stdio binary, the server exits at startup with an error message saying `--root` is HTTP-only. This is intentional: in stdio, the client is the authority on what is in scope.

Not every stdio client advertises the workspace as a root. Claude Code currently does not. If the server's working directory itself looks like a Cedar policy store (one of `schema.cedarschema`, `schema.json`, or a `policies/` directory exists), the server loads the cwd as a store named after the cwd's basename **synchronously at startup, before the transport accepts any client requests**. By the time the client can send anything (including `resources/list`), the store is already populated. This is the "user opens an MCP-enabled CLI inside their Cedar repo and expects the tools to work" path.

When the MCP client later advertises roots via `listRoots()` (during the initialize handshake) or via a `notifications/roots/list_changed` message, those roots **replace** the sync-loaded cwd-fallback. A client that advertises roots is stating authoritative intent. When the client advertises zero roots, the sync-loaded cwd-fallback is preserved. The server also emits `notifications/resources/list_changed` after any reconciliation pass so cache-aware clients can refresh on the rare swap.

In HTTP mode, there is no client workspace to negotiate with; the operator running the long-lived process is the authority. The `--root name=path` flag is how the deployer tells the server "expose this directory as a named policy store". Pass `--root` once per store. Every connected HTTP client sees the same set of roots.

### Endpoints

- `POST /mcp`: the MCP Streamable HTTP endpoint. Each session gets a unique `Mcp-Session-Id` returned on the initialize response and required on subsequent requests.
- `GET /health`: returns `{ status, transport, mode, active_sessions }` JSON. Useful for liveness probes.

### Client configuration

Point any Streamable-HTTP-capable MCP client at `http://<host>:<port>/mcp`. Example (Claude Code or similar) using the SDK's `StreamableHTTPClientTransport`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "team", version: "1.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL("http://cedar-mcp.internal:3000/mcp"));
await client.connect(transport);
```

### Sharing model and limitations

The HTTP server runs **one shared `storeManager`** across all concurrent sessions. The deployment model is "one server per policy-store set; many team clients all see the same roots." Every client connected to the same HTTP server reads the same `--root` mappings. For per-tenant isolation (different teams seeing different policy stores), deploy multiple processes behind a routing layer.

Each MCP session DOES get its own `McpServer` instance; protocol state (initialized, message history, sampling) is per-session as the MCP spec requires.

### Security

- Default localhost binding plus the SDK's built-in DNS rebinding protection covers the local team-dev case.
- Non-localhost binding (`--host 0.0.0.0` or a public IP) is on you to secure. Recommended pattern: terminate TLS at a reverse proxy (nginx, Caddy, Cloudflare), add bearer-token or mTLS auth at that layer, forward the `POST /mcp` and `GET /health` paths to the server.
- v1 ships without built-in auth or CORS. Both are deferred until real demand surfaces.
- See `SECURITY.md` for the trust boundary and input validation guarantees.
