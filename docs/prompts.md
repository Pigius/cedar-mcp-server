# MCP Prompts

In addition to tools, the server registers three MCP prompts that clients surface as slash commands or pre-canned message templates. Each prompt takes arguments, then returns an assembled message that drives the assistant through a structured Cedar workflow.

| Prompt | Arguments | What it does |
|--------|-----------|--------------|
| `cedar-review-policy-diff` | `blue_store` (required), `green_store` (required), `focus` (optional) | Drives `cedar_diff_policy_stores` + `cedar_diff_schema`, summarizes structural changes plus risk-classified schema diff, and recommends whether to promote. |
| `cedar-explain-denial` | `principal`, `action`, `resource`, `store` (all required) | Runs `cedar_authorize` against the store via `cedar://` refs, calls `cedar_explain` on the deciding policies, and produces a plain-English explanation of why the request was denied (or allowed) plus what would need to change. |
| `cedar-avp-migration-checklist` | `namespace` (optional) | Returns a guided checklist for migrating an AVP policy store: schema validation, entity format detection, single-namespace constraint, template-linked policies, schema diff before `PutSchema`, behavioral diff before traffic shift. Informational only; no tool calls assumed. |

In Claude Code these appear under the `/` slash menu when the server is configured. Other clients surface them differently per their UI conventions.
