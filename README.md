# cedar-mcp-server

`cedar-mcp-server` is an MCP server that puts Cedar policy tooling directly inside your AI assistant conversation. It covers the full Cedar policy lifecycle: validate policies, simulate authorization decisions, plan changes against AVP constraints, and diff two policy stores for blue/green deployment. Cedar 4.11.0 runs in-process via WASM, so there's nothing to install beyond `npx`.

[![CI](https://github.com/Pigius/cedar-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Pigius/cedar-mcp-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/cedar-mcp-server)](https://www.npmjs.com/package/cedar-mcp-server)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

---

## In a nutshell

Cedar is AWS's open-source authorization policy language (the engine behind Amazon Verified Permissions). Writing and maintaining Cedar policies by hand is doable but error-prone: schema typing, AVP `UpdatePolicy` mutability rules, optional-attribute silent-skip behavior, blue/green deployment safety, and template-link semantics all hide gotchas that a code-review or text-diff cannot catch.

This server exposes the Cedar parser, evaluator, formatter, AST analyzer, change-classifier, and policy-store differ as MCP tools that an AI assistant (Claude Code, Claude Desktop, Cursor, any MCP 1.0 client) can call directly. The assistant gets ground-truth answers instead of paraphrasing the policy text; you keep the conversational interface.

---

## What's inside

Seventeen tools across six categories, plus three MCP prompts and two transports (stdio for individual developers, Streamable HTTP for shared team deployments).

#### Authorization

| Tool | What it does |
|------|-------------|
| [`cedar_authorize`](docs/tools.md#cedar_authorize) | Evaluates one authorization request locally; returns the decision and which policies fired |
| [`cedar_authorize_batch`](docs/tools.md#cedar_authorize_batch) | Runs N authorization requests through one policy set and returns the decision matrix; for regression testing after a policy edit |

#### Validation

| Tool | What it does |
|------|-------------|
| [`cedar_validate`](docs/tools.md#cedar_validate) | Validates Cedar policies against a schema; returns errors with hints and source locations |
| [`cedar_validate_schema`](docs/tools.md#cedar_validate_schema) | Validates a Cedar schema in isolation (no policies required); returns parse errors and namespace/type counts |
| [`cedar_validate_template`](docs/tools.md#cedar_validate_template) | Validates a Cedar template against a schema; detects slot placeholders |
| [`cedar_validate_entities`](docs/tools.md#cedar_validate_entities) | Validates a Cedar entities JSON array against a schema; classifies errors by kind |

#### Formatting and translation

| Tool | What it does |
|------|-------------|
| [`cedar_format`](docs/tools.md#cedar_format) | Formats Cedar policy text to canonical style |
| [`cedar_translate`](docs/tools.md#cedar_translate) | Translates between Cedar text and Cedar JSON formats for policies and schemas |

#### Planning and analysis

| Tool | What it does |
|------|-------------|
| [`cedar_explain`](docs/tools.md#cedar_explain) | Explains a Cedar policy in plain English with pattern detection |
| [`cedar_check_policy_change`](docs/tools.md#cedar_check_policy_change) | Determines whether a policy modification can be applied in-place in AVP or requires delete-and-recreate |
| [`cedar_generate_sample_request`](docs/tools.md#cedar_generate_sample_request) | Generates a complete authorization request payload that produces a target decision |
| [`cedar_advise`](docs/tools.md#cedar_advise) | Returns a structured context bundle (schema summary, policy inventory with pattern classification, gotchas, AVP rules, sequencing guidance) for any policy-change intent so the calling assistant can plan correctly |

#### Templates

| Tool | What it does |
|------|-------------|
| [`cedar_link_template`](docs/tools.md#cedar_link_template) | Instantiates a template by binding `?principal` and `?resource` slots to specific entity references |
| [`cedar_list_templates`](docs/tools.md#cedar_list_templates) | Lists all templates in a policy store |
| [`cedar_list_template_links`](docs/tools.md#cedar_list_template_links) | Lists all template-linked policy instances in a store |

#### Diffing

| Tool | What it does |
|------|-------------|
| [`cedar_diff_schema`](docs/tools.md#cedar_diff_schema) | Structural diff of two schemas with AVP-aware risk classification per change (safe/review/breaking) |
| [`cedar_diff_policy_stores`](docs/tools.md#cedar_diff_policy_stores) | Structural and optional behavioral diff between two policy stores with AVP immutability classification |

For full per-tool detail, see [`docs/tools.md`](docs/tools.md).

---

## Quick start

Register with your MCP client:

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

(Path varies per client: `.claude/settings.json` for Claude Code, `claude_desktop_config.json` for Claude Desktop, `.cursor/mcp.json` for Cursor.)

Then in your client conversation:

```
Validate this Cedar policy against this schema: [paste policy and schema]
```

Or with a Cedar workspace on disk, open the assistant from that directory:

```
I want to make editors read-only, admins exempt. Plan it.
```

For per-client configuration, running from source, configuring MCP roots so the server reads your live policy files, and switching to Streamable HTTP for team deployments, see [`docs/getting-started.md`](docs/getting-started.md) and [`docs/http-mode.md`](docs/http-mode.md).

---

## How this relates to `cedar-policy/cedar-for-agents`

The official Cedar org publishes [`cedar-policy/cedar-for-agents`](https://github.com/cedar-policy/cedar-for-agents), a multi-language toolkit (Rust crates plus a JS MCP server) for **using Cedar to constrain what an AI agent can do**. Its components: an `mcp-tools-sdk` for parsing MCP tool descriptions, a `cedar-policy-mcp-schema-generator` that auto-generates Cedar schemas from MCP server tools (so you can write Cedar policies governing agent tool use), and `cedar-analysis-mcp-server` exposing Cedar's SMT-backed symbolic analysis (equivalence, shadowing, reachability) via MCP.

`cedar-mcp-server` targets the opposite direction: **using an AI agent to help you author and maintain Cedar policies**. The 17 tools above are the everyday parse / evaluate / validate / format / plan / diff loop, with explicit AVP-deployment classification (`UpdatePolicy` mutability rules, behavioral diffing across stores, migration checklist). It does not ship the SMT analysis surface; that's `cedar-policy-symcc` upstream, which is what `cedar-for-agents`'s `cedar-analysis-mcp-server` exposes.

The two are complementary, not competing. A team using Cedar with an AI assistant in 2026 could plausibly load both servers in the same MCP client: this one for the daily authoring loop, theirs for the occasional SMT-level analysis question and for agent-permission governance.

---

## Documentation

- [Getting started](docs/getting-started.md): install, register with Claude Code / Claude Desktop / Cursor, configure policy stores via MCP roots, use `cedar://` URIs.
- [Workflows](docs/workflows.md): why route through this server vs reading the files directly; the PLAN / DIFF / APPLY loop the tool surface is designed for.
- [Tool reference](docs/tools.md): all 17 tools with example prompts and captured responses.
- [MCP Prompts](docs/prompts.md): the three slash-commands the server registers.
- [HTTP mode](docs/http-mode.md): Streamable HTTP transport for shared team deployments.
- [Migrating from AVP or cedar-cli](docs/migrating.md): entity-format autodetection, template-link operations, what's covered vs. what isn't.
- [Coming fresh to Cedar](docs/cedar-primer.md): the policy language in five paragraphs.
- [Troubleshooting and known limitations](docs/troubleshooting.md): common errors, compatibility table, what SMT-backed analysis is intentionally NOT bundled.

---

## Versioning

SemVer from v1.0.0 onward. Major versions may introduce breaking changes to tool input/output schemas. Minor versions add capabilities without breaking existing inputs. Patches are bug fixes.

See [`CHANGELOG.md`](./CHANGELOG.md) for the full release history.

---

## Examples

See [`examples/`](./examples/) for three full working scenarios with schemas, policies, entities, and copy-paste prompts:

- [`rbac-document-management`](./examples/rbac-document-management/): role membership, `forbid` + `unless`, default deny.
- [`abac-multi-tenant`](./examples/abac-multi-tenant/): attribute conditions, `contains()`, optional attribute guards, plan-tier gating.
- [`api-gateway-path-routing`](./examples/api-gateway-path-routing/): path matching with `like`, depth limiting via negation, method restriction.

Each example includes a `run.ts` that exercises all tools offline without an MCP client.

---

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). For security disclosures, see [`SECURITY.md`](./SECURITY.md).

---

## License

Apache 2.0, same as Cedar itself. See [`LICENSE`](./LICENSE).

---

## Acknowledgments

- [Cedar team at AWS](https://github.com/cedar-policy/cedar) for the open-source Cedar engine and the `@cedar-policy/cedar-wasm` bindings.
- [Amazon Verified Permissions team](https://aws.amazon.com/verified-permissions/) for the production service this server complements.
- [Anthropic MCP team](https://modelcontextprotocol.io) for the protocol and SDK.
- Built by [Daniel Aniszkiewicz](https://builder.aws.com/community/heroes/DanielAniszkiewicz), AWS Hero.
