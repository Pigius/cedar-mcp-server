# Getting started

Install, register the server with your MCP client, and configure policy stores so the server can read your live Cedar files instead of asking you to paste them.

## How MCP stdio servers work

Your MCP client (Claude Code, Claude Desktop, Cursor) spawns `cedar-mcp-server` as a child process when it needs Cedar tooling. You do not run the server directly. You configure your client to point at it once, and the client manages the process lifecycle over stdio for each session. If you try `node dist/index.js` in a terminal it will appear to hang; that is the server waiting for JSON-RPC messages on stdin. Stop it with `Ctrl+C`.

## Install

For the published package:

```bash
npx -y cedar-mcp-server
```

Or install globally:

```bash
npm install -g cedar-mcp-server
```

## Run from source (for contributors)

```bash
git clone https://github.com/Pigius/cedar-mcp-server.git
cd cedar-mcp-server
npm install
npm run build      # compiles TypeScript to dist/
```

Then point your MCP client at the built entry. Replace `command: "npx"` and `args: ["-y", "cedar-mcp-server"]` in the configs below with:

```json
{ "command": "node", "args": ["/absolute/path/to/cedar-mcp-server/dist/index.js"] }
```

Or run directly via `tsx` without a build step:

```json
{ "command": "npx", "args": ["tsx", "/absolute/path/to/cedar-mcp-server/src/index.ts"] }
```

## Register with your MCP client

### Claude Code

Add to `.claude/settings.json` in your project, or to `~/.claude/settings.json` globally:

```json
{
  "mcpServers": {
    "cedar": {
      "command": "npx",
      "args": ["-y", "cedar-mcp-server"]
    }
  }
}
```

If you register via `claude mcp add` instead of editing settings.json by hand, run the command from the directory you will actually use the server in. Claude Code stores MCP configurations per-project by default, so a registration done from one project does not surface in another. For a single global registration that works across every project, add `--scope user`:

```bash
claude mcp add --scope user cedar -- npx -y cedar-mcp-server
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cedar": {
      "command": "npx",
      "args": ["-y", "cedar-mcp-server"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "cedar": {
      "command": "npx",
      "args": ["-y", "cedar-mcp-server"]
    }
  }
}
```

Once published, first `npx` run pulls the package; subsequent runs use the npm cache.

Then in your client conversation:

```
Validate this Cedar policy against this schema: [paste policy and schema]
```

---

## Configure policy stores (MCP Roots)

If your Cedar policies live on disk, configure MCP roots once and the server reads them directly. No more pasting policy text into every tool call.

### Policy store layout

Each root directory must follow this structure:

```
my-store/
  policies/
    admin.cedar
    editor.cedar
    viewer.cedar
  templates/
    viewer-access.cedar        <- Cedar template with ?principal / ?resource slots (optional)
  template-links/
    alice-docs.json            <- { "template_id": "...", "slot_values": { ... } } (optional)
  schema.cedarschema           <- Cedar schema text (preferred)
  schema.json                  <- Cedar JSON schema (alternative)
```

### Configure roots in Claude Code

Add roots to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "cedar": {
      "command": "npx",
      "args": ["-y", "cedar-mcp-server"],
      "roots": [
        { "uri": "file:///path/to/production-store", "name": "production" },
        { "uri": "file:///path/to/staging-store", "name": "staging" }
      ]
    }
  }
}
```

The root name (`"production"`, `"staging"`) becomes the store identifier used in tool calls.

### Use `cedar://` references instead of inline text

Once roots are configured, use `cedar://` URIs instead of pasting policy text:

```
cedar://policies/production              <- all policies in the production store
cedar://policies/production/admin        <- the admin.cedar policy
cedar://schema/production                <- the production schema
cedar://templates/production             <- all templates in the production store
cedar://templates/production/viewer-access  <- the viewer-access template
cedar://template-links/production        <- all template-link IDs in the store
cedar://template-links/production/alice-docs  <- a specific link's metadata
cedar://entities/production              <- merged entity JSON across all entities/*.json files
cedar://entities/production/users-and-docs  <- a single entity file
```

Both `policy_ref` and `schema_ref` accept these URIs in `cedar_validate` and `cedar_authorize`. Inline text still works; pass either form.

### Error when no stores are configured

If you call `cedar_diff_policy_stores` or use a `cedar://` reference but haven't configured roots, the error message explains the expected directory layout and how to configure roots in your MCP client settings.
