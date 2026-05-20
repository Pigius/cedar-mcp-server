# Examples

Three self-contained Cedar authorization scenarios. Each one has a schema, policy files, an entity store, a runnable script, and a README with copy-paste prompts for Claude Code.

## Pick your pattern

| Example | Cedar patterns | Start here if... |
|---------|---------------|-----------------|
| [rbac-document-management](./rbac-document-management/) | Role membership, `forbid` + `unless`, default deny | You're new to Cedar or building a simple role-based system |
| [abac-multi-tenant](./abac-multi-tenant/) | Attribute conditions, `contains()`, optional attribute guards, plan-tier gating | You need decisions based on resource or user attributes, not just roles |
| [api-gateway-path-routing](./api-gateway-path-routing/) | Path matching with `like`, depth limiting via negation, method restriction | You're authorizing HTTP requests at a gateway or proxy |

## Run all examples offline

Each example includes a `run.ts` that exercises all tools against the example files. No MCP client or AI assistant required.

```bash
npx tsx examples/rbac-document-management/run.ts
npx tsx examples/abac-multi-tenant/run.ts
npx tsx examples/api-gateway-path-routing/run.ts
```

## Use with Claude Code

Add `cedar-mcp-server` to your MCP configuration, then paste the prompts from any example README directly into a conversation. The examples are designed so the tool inputs fit in a single message.

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
