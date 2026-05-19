# cedar-mcp-server

MCP server for Cedar policy language — validate, authorize, format, and translate Cedar policies directly in your AI assistant.

Built on the official [`@cedar-policy/cedar-wasm`](https://www.npmjs.com/package/@cedar-policy/cedar-wasm) bindings. No Docker, no AWS credentials, no Cedar expertise required.

---

## Install

```bash
npx cedar-mcp-server
```

### Claude Code

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

---

## Tools

| Tool | What it does |
|------|-------------|
| `cedar_validate` | Validate Cedar policies against a schema |
| `cedar_authorize` | Evaluate an authorization request locally |
| `cedar_format` | Format Cedar policies to canonical style |
| `cedar_translate` | Translate between Cedar text and JSON formats |

Full documentation in [`docs/`](./docs/).

---

## License

Apache 2.0 — same as Cedar itself.
