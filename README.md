# cedar-mcp-server

`cedar-mcp-server` is an MCP server that puts Cedar policy tooling directly inside your AI assistant conversation. It covers the full Cedar policy lifecycle: validate policies, simulate authorization decisions, plan changes against AVP constraints, and diff two policy stores for blue/green deployment. Cedar 4.11.0 runs in-process via WASM, so there's nothing to install beyond `npx`.

[![npm version](https://img.shields.io/npm/v/cedar-mcp-server)](https://www.npmjs.com/package/cedar-mcp-server)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

---

## What it does

Nine tools across three categories:

**Validation and evaluation** — work with Cedar policies without leaving the conversation.

| Tool | What it does |
|------|-------------|
| [`cedar_validate`](#cedar_validate) | Validates Cedar policies against a schema; returns errors with hints and source locations |
| [`cedar_authorize`](#cedar_authorize) | Evaluates an authorization request locally; returns the decision and which policies fired |
| [`cedar_format`](#cedar_format) | Formats Cedar policy text to canonical style |
| [`cedar_translate`](#cedar_translate) | Translates between Cedar text and Cedar JSON formats for policies and schemas |

**Planning and understanding** — reason about policy design and changes before writing code.

| Tool | What it does |
|------|-------------|
| [`cedar_explain`](#cedar_explain) | Explains a Cedar policy in plain English with pattern detection |
| [`cedar_check_policy_change`](#cedar_check_policy_change) | Determines whether a policy modification can be applied in-place in AVP or requires delete-and-recreate |
| [`cedar_generate_sample_request`](#cedar_generate_sample_request) | Generates a complete authorization request payload that produces a target decision |
| [`cedar_advise`](#cedar_advise) | Translates a natural-language intent into a step-by-step Cedar policy change plan (uses MCP sampling) |

**Diffing** — compare two policy stores before promoting changes to production.

| Tool | What it does |
|------|-------------|
| [`cedar_diff_policy_stores`](#cedar_diff_policy_stores) | Structural and optional behavioral diff between two policy stores with AVP immutability classification |

---

## Quick start

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

First run pulls the package via `npx`. Subsequent runs use the npm cache.

Then in your client conversation:

```
Validate this Cedar policy against this schema: [paste policy and schema]
```

---

## The workflow it enables

This server is designed around three steps in any Cedar policy lifecycle.

### 1. PLAN: from intent to a step-by-step Cedar policy change plan

Use `cedar_advise` to translate a natural-language description of what you want into a concrete, ordered list of Cedar and schema changes, with AVP deployment classification for each step.

```
You: I need to add a "contractor" role that can read documents
     but only if the document is marked as "external_share".
     Here's my current policy store: [attach via cedar:// ref or paste]

AI:  [calls cedar_advise]

     Step 1: Schema — no changes needed; "classification" attribute already exists.
     Step 2: Policy (new_policy_via_create_policy):
       permit (
         principal in DocMgmt::Role::"contractor",
         action == DocMgmt::Action::"read",
         resource
       )
       when { resource.classification == "external_share" };
     Gotcha (high): accessing resource.classification without a guard works here
     because the attribute is required in the schema — but if you make it optional
     later, add `resource has classification &&` before the check.
```

### 2. DIFF: from "what changed" to "is it safe to deploy"

Configure two policy stores as MCP roots (production and staging), then use `cedar_diff_policy_stores` to get a structural diff plus AVP immutability classification for each change.

```
You: Compare staging and production policies before I promote.

AI:  [calls cedar_diff_policy_stores with blue: "production", green: "staging"]

     Added: contractor-read-external.cedar (new_policy_via_create_policy — safe to add)
     Modified: editor-policy.cedar (principal clause changed — requires_delete_recreate)
     Schema: unchanged

     Behavioral diff (optional): pass a list of authorization requests to see
     which decisions would change between the two stores.
```

### 3. APPLY: deploy with confidence

The server doesn't call AVP APIs directly. Apply your changes through your own deployment pipeline. The `avp_update_mode` classification from steps 1 and 2 tells you exactly which AVP operations each change requires:

- `new_policy_via_create_policy` — safe to add with `CreatePolicy`
- `in_place_via_update_policy` — change action or conditions with `UpdatePolicy`
- `requires_delete_recreate` — principal, resource, or effect changed; use `DeletePolicy` then `CreatePolicy`

See [`avp-cli`](https://github.com/Pigius/avp-cli) for a companion CLI that handles the pull/push side.

---

## Tool details

### `cedar_validate`

Validates Cedar policies against a schema. Returns errors with hints, source locations, and the policy count.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `policies` | yes (or `policy_ref`) | Cedar policy text (one or more policies) |
| `schema` | yes (or `schema_ref`) | Cedar schema (JSON object or `.cedarschema` text) |
| `policy_ref` | no | `cedar://` URI pointing to a policy in a configured store |
| `schema_ref` | no | `cedar://` URI pointing to a schema in a configured store |

**Valid policy:**

```json
{
  "valid": true,
  "errors": [],
  "warnings": [],
  "policy_count": 1
}
```

**Invalid policy (attribute not found in schema):**

```json
{
  "valid": false,
  "errors": [
    {
      "policy_id": "policy0",
      "message": "attribute `nonexistent` on entity type `DocMgmt::Document` not found",
      "hint": "did you mean `classification`?"
    }
  ],
  "policy_count": 1
}
```

**When to use:** every time you write or modify a policy. Schema validation catches attribute typos, entity type mismatches, and action applicability errors before they become silent runtime surprises.

---

### `cedar_authorize`

Evaluates an authorization request locally against your policies and entities. Returns the decision and which policies fired.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `policies` | yes (or `policy_ref`) | Cedar policy text |
| `principal` | yes | Entity reference, e.g. `DocMgmt::User::"alice"` |
| `action` | yes | Entity reference, e.g. `DocMgmt::Action::"read"` |
| `resource` | yes | Entity reference, e.g. `DocMgmt::Document::"doc-001"` |
| `entities` | yes | JSON array of entity objects (uid, attrs, parents) |
| `schema` | no (or `schema_ref`) | Cedar schema; enables request validation |
| `context` | no | JSON object with context attributes |
| `policy_ref` | no | `cedar://` URI for policy store reference |
| `schema_ref` | no | `cedar://` URI for schema reference |

**Allow:**

```json
{
  "decision": "Allow",
  "determining_policies": ["policy0"],
  "errors": []
}
```

**Deny (no policy matched):**

```json
{
  "decision": "Deny",
  "determining_policies": [],
  "errors": []
}
```

`determining_policies` lists the policy IDs that contributed to the decision. On a deny caused by a `forbid` policy, that policy's ID appears here. An empty list means default deny: no `permit` matched.

**When to use:** verifying authorization logic after writing a policy, and checking that your entity payloads produce the expected decisions before deploying.

---

### `cedar_format`

Formats Cedar policy text to canonical style. Useful before committing policy files or pasting into pull requests.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `policies` | yes | Cedar policy text to format |
| `line_width` | no | Maximum line width (default: 80) |
| `indent_width` | no | Indent width in spaces (default: 2) |

**Example:**

Input: `permit(principal in DocMgmt::Role::"admin",action,resource);`

Output:

```cedar
permit (
  principal in DocMgmt::Role::"admin",
  action,
  resource
);
```

**When to use:** before committing policy files. Canonical formatting makes diffs readable and policy reviews easier.

---

### `cedar_translate`

Translates between Cedar text and JSON formats for policies and schemas.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `input` | yes | Cedar text or JSON string to translate |
| `type` | yes | `"policy"` or `"schema"` |
| `direction` | yes | `"to_json"` or `"to_cedar"` |

**Policy to JSON:**

Input Cedar:
```cedar
permit (
  principal in DocMgmt::Role::"admin",
  action,
  resource
);
```

Output JSON:
```json
{
  "effect": "permit",
  "principal": {
    "op": "in",
    "entity": { "type": "DocMgmt::Role", "id": "admin" }
  },
  "action": { "op": "All" },
  "resource": { "op": "All" },
  "conditions": []
}
```

**When to use:** programmatic policy inspection, generating policies from code, or feeding policy structure into tools that work with JSON.

---

### `cedar_explain`

Explains a Cedar policy in plain English with pattern detection.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `policy` | yes | A single Cedar policy (not a policy set) |
| `schema` | no | Cedar schema; improves entity type descriptions |

**Output shape:**

```json
{
  "effect": "forbid",
  "principal": { "scope": "All", "description": "any principal" },
  "action": { "scope": "All", "description": "any action" },
  "resource": { "scope": "All", "description": "any resource" },
  "conditions": [
    { "kind": "when", "text": "WHEN resource.classification equals \"top_secret\"" },
    { "kind": "unless", "text": "UNLESS principal is in role admin" }
  ],
  "summary": "FORBIDS any principal from any action on any resource WHEN resource.classification equals \"top_secret\" UNLESS principal is in role admin.",
  "patterns_detected": ["forbid_policy", "attribute_condition", "role_exemption"]
}
```

**When to use:** onboarding teammates onto an existing policy set, auditing policies you didn't write, or explaining the intent behind a complex `when`/`unless` combination.

---

### `cedar_check_policy_change`

Determines whether a policy modification can be applied in-place in AWS Verified Permissions or requires delete-and-recreate.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `old_policy` | yes | Existing Cedar policy text |
| `new_policy` | yes | Updated Cedar policy text |

**Output shape:**

```json
{
  "can_update_in_place": false,
  "changes": [
    {
      "field": "principal",
      "old_value": "in DocMgmt::Role::\"viewer\"",
      "new_value": "in DocMgmt::Role::\"senior_viewer\"",
      "in_place_allowed": false,
      "reason": "Changing the principal clause requires deleting and recreating the policy."
    }
  ],
  "recommendation": "This policy requires delete-and-recreate. Use DeletePolicy then CreatePolicy."
}
```

**AVP immutability rules:**

| Field | In-place via UpdatePolicy? |
|-------|--------------------------|
| `effect` | No — delete and recreate |
| `principal` | No — delete and recreate |
| `resource` | No — delete and recreate |
| `action` | Yes |
| `conditions` (when/unless) | Yes |

**When to use:** before deploying any policy change to AVP. Knowing upfront whether a change requires delete-and-recreate prevents surprises in production.

---

### `cedar_generate_sample_request`

Generates a complete authorization request payload that produces a target decision against a given policy.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `policy` | yes | A single Cedar policy |
| `schema` | yes | Cedar schema for the namespace |
| `target_decision` | yes | `"allow"` or `"deny"` |

**Output shape:**

```json
{
  "principal": "DocMgmt::User::\"generated-user\"",
  "action": "DocMgmt::Action::\"read\"",
  "resource": "DocMgmt::Document::\"generated-doc\"",
  "entities": [...],
  "explanation": "Principal is in DocMgmt::Role::\"admin\" via parents — matches the permit condition.",
  "decision": "Allow",
  "ready_to_test": true
}
```

**When to use:** generating test payloads without hand-crafting entities, or verifying that a policy produces the decisions you expect before deploying it. Pass the output directly to `cedar_authorize` to verify.

---

### `cedar_advise`

Translates a natural-language description of an authorization intent into a step-by-step Cedar policy change plan. Uses MCP sampling, so the AI client handles the LLM call and pays for it.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `intent` | yes | Natural-language description of the desired authorization behavior |
| `store_ref` | no | Store name or `cedar://` URI; provides the server with current schema and policy context |
| `previous_plan` | no | A previous `cedar_advise` result; triggers delta output (unchanged/modified/added/removed steps) |

**Output shape (full plan):**

```json
{
  "intent_interpretation": "Allow contractor principals to read documents classified as external_share.",
  "applicable_cedar_pattern": "Membership (RBAC) with attribute condition",
  "affected_entities": {
    "principal_type": "DocMgmt::Role",
    "action_ids": ["read"],
    "resource_type": "DocMgmt::Document"
  },
  "required_changes": [
    {
      "step": 1,
      "type": "policy_new",
      "description": "Create a new permit policy for the contractor role",
      "cedar_snippet": "permit (\n  principal in DocMgmt::Role::\"contractor\",\n  action == DocMgmt::Action::\"read\",\n  resource\n)\nwhen { resource.classification == \"external_share\" };",
      "avp_update_mode": "new_policy_via_create_policy",
      "avp_consideration": "Use CreatePolicy with a static policy body."
    }
  ],
  "gotchas": [...],
  "verification_next_steps": "Validate the new policy against the schema, then run cedar_authorize with a contractor principal and a document with classification=external_share."
}
```

**Note:** `cedar_advise` requires an MCP client that supports sampling (e.g. Claude Code, Claude Desktop). Clients that don't support sampling will receive an error. LLM-generated Cedar snippets in the plan are validated before return; any snippets that fail to parse are surfaced as high-severity gotchas rather than passed through silently.

**When to use:** starting a policy design from scratch, translating a business requirement into Cedar, or iteratively refining a plan by passing the previous plan back as `previous_plan`.

---

### `cedar_diff_policy_stores`

Structural and optional behavioral diff between two policy stores. Requires MCP Roots configured (see [Setup with policy stores](#setup-with-policy-stores-mcp-roots)).

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `blue` | yes | Store name for the base (e.g. `"production"`) |
| `green` | yes | Store name for the proposed changes (e.g. `"staging"`) |
| `behavioral_test_requests` | no | JSON string of authorization requests to run through both stores; surfaces decision drift |

**Output shape:**

```json
{
  "blue": "production",
  "green": "staging",
  "policies_added": [
    { "policy_id": "contractor-read", "content": "permit (...);" }
  ],
  "policies_removed": [],
  "policies_modified": [
    {
      "policy_id": "editor-policy",
      "can_update_in_place": false,
      "changes": [{ "field": "principal", "in_place_allowed": false, "reason": "..." }],
      "recommendation": "Requires delete-and-recreate."
    }
  ],
  "schema_changed": false,
  "behavioral_diff": [
    {
      "principal": "DocMgmt::User::\"contractor-1\"",
      "action": "DocMgmt::Action::\"read\"",
      "resource": "DocMgmt::Document::\"external-doc\"",
      "blue_decision": "Deny",
      "green_decision": "Allow",
      "drifted": true
    }
  ],
  "summary": "1 policy added, 1 modified (requires delete-recreate), schema unchanged."
}
```

**When to use:** before promoting any policy changes from staging to production. The structural diff tells you what changed and how to deploy it. The behavioral diff tells you which authorization decisions would actually change.

---

## Setup with policy stores (MCP Roots)

If your Cedar policies live on disk, configure MCP roots once and the server reads them directly. No more pasting policy text into every tool call.

### Policy store layout

Each root directory must follow this structure:

```
my-store/
  policies/
    admin.cedar
    editor.cedar
    viewer.cedar
  schema.cedarschema     <- Cedar schema text (preferred)
  schema.json            <- Cedar JSON schema (alternative)
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
cedar://policies/production           <- all policies in the production store
cedar://policies/production/admin     <- the admin.cedar policy
cedar://schema/production             <- the production schema
```

Both `policy_ref` and `schema_ref` accept these URIs in `cedar_validate` and `cedar_authorize`. Inline text still works — pass either form.

### Error when no stores are configured

If you call `cedar_diff_policy_stores` or use a `cedar://` reference but haven't configured roots, the error message explains the expected directory layout and how to configure roots in your MCP client settings.

---

## Coming from AWS Verified Permissions?

If you're already using AVP, your entity JSON looks different from Cedar's open-source format. `cedar_authorize` detects and converts all three AVP SDK formats automatically.

| What you have | What's auto-detected |
|---|---|
| Ruby SDK (`entity_type`, `entity_id`) | snake_case AVP format |
| Python / JS SDK v3 (`entityType`, `entityId`) | camelCase AVP format |
| AWS console / official API (`EntityType`, `EntityId`) | PascalCase AVP format |

Typed attribute wrappers (`{ "string": "val" }`, `{ "long": 42 }`, `{ "boolean": true }`) are unwrapped to raw Cedar values. Entity references in attributes (`entityIdentifier`) are converted to Cedar's `__entity` format. `Set` and `Record` wrappers are unwrapped recursively.

The response includes `format_detected` and `format_note` telling you what was detected:

```json
{
  "decision": "Allow",
  "format_detected": "avp",
  "format_note": "Entities are in AVP format. Automatically converted to Cedar format."
}
```

**Three things to know when migrating from AVP:**

1. Action groups are not automatic. AVP appends action group entities to the entity list for you. With this tool, include them manually in the `entities` array.

2. The `entities` SDK envelope is handled. If you pass the full SDK value (`{ entity_list: [...] }` or `{ entityList: [...] }`), it is automatically unwrapped.

3. One namespace only. AVP policy stores support a single namespace. This tool works with multi-namespace Cedar schemas, but your AVP-derived policies will only reference one.

---

## Coming from cedar-cli or cedar-policy-cli?

The Cedar project ships a CLI (`cedar`) for one-shot policy operations. This MCP server is complementary, not a replacement.

| Operation | cedar CLI | cedar-mcp-server |
|-----------|-----------|------------------|
| Validate a policy file | `cedar validate` | `cedar_validate` |
| Evaluate a request | `cedar authorize` | `cedar_authorize` |
| Format a policy file | `cedar format` | `cedar_format` |
| Translate policy to JSON | `cedar translate` | `cedar_translate` |
| Explain a policy | — | `cedar_explain` |
| Check if a change needs delete-recreate | — | `cedar_check_policy_change` |
| Generate a test request payload | — | `cedar_generate_sample_request` |
| Plan a policy change from intent | — | `cedar_advise` |
| Diff two policy stores with AVP classification | — | `cedar_diff_policy_stores` |

**When to use the CLI:** one-shot scripts, CI pipelines, or shell automation.

**When to use this server:** conversational workflows where you want Cedar reasoning inside the same context as your question, workspace-aware operations (reading live policy files from disk via roots), or the planning and diffing tools that have no CLI equivalent.

A practical pattern: use `avp-cli` to pull policy stores from AVP to disk, then use this server's roots support to read them for diffing and planning.

---

## Coming fresh to Cedar?

Cedar is a policy language built around three entities: a **principal** (who's asking), an **action** (what they want to do), and a **resource** (what they want to do it to). Authorization is the question: does a `permit` policy match this triple, without any `forbid` policy blocking it?

A few things that shape how you write policies:

**Default deny.** Cedar denies every request unless a `permit` policy explicitly matches. There is no "allow by default" option.

**`forbid` overrides `permit`.** A single matching `forbid` blocks the request regardless of how many `permit` policies also match. If you need an exception to a `forbid`, use `unless`:

```cedar
forbid (principal, action, resource)
when { resource.classification == "top_secret" }
unless { principal in DocMgmt::Role::"admin" };
```

**Namespaces are part of entity type names.** `DocMgmt::User::"alice"` is the canonical form. The double colon separates namespace from type, and the quoted string is the entity ID.

**Start with `cedar_advise`.** Describe what you want in plain language and let the server produce a starting policy. Then validate it with `cedar_validate` and verify the decision with `cedar_authorize`.

The upstream [Cedar documentation](https://docs.cedarpolicy.com) and [Cedar policy patterns](https://docs.cedarpolicy.com/overview/patterns.html) are the authoritative reference.

---

## Troubleshooting

**"schema not found in store"**

The server looked for `schema.cedarschema` or `schema.json` in the root directory but found neither. Check that your policy store directory has one of these files at the root level, not inside the `policies/` subdirectory.

**"store X not found — no roots configured"**

You passed a `cedar://` reference or a store name to a tool, but no MCP roots are configured. Add a `roots` entry to your MCP client config (see [Setup with policy stores](#setup-with-policy-stores-mcp-roots)).

**"policy_text and policy_ref both provided"**

Inline text takes precedence, but passing both is probably a mistake. Remove one.

**"Failed to initialize Cedar WASM"**

The `@cedar-policy/cedar-wasm` module failed to load. This typically means the npm package is corrupted or the Node.js version is too old. Run `node --version` and verify it's 20 or higher. Delete `node_modules` and reinstall if the version is correct.

**"MCP client does not support sampling" (cedar_advise)**

`cedar_advise` requires the MCP client to support the `sampling/createMessage` capability. Claude Code and Claude Desktop support this. Some other MCP clients don't. Check your client's documentation.

**"Name collision: two roots share the last path segment"**

The server names stores after the last segment of their file path. If two roots resolve to the same name (e.g. `/path/a/policies` and `/path/b/policies`), the second one gets a numeric suffix (`policies-2`). Check your roots config and give each store a unique path.

---

## Compatibility

| Component | Tested version |
|-----------|---------------|
| Cedar | 4.11.0 |
| `@cedar-policy/cedar-wasm` | 4.11.0 |
| Node.js | 20.x and above |
| `@modelcontextprotocol/sdk` | 1.29.0 |
| MCP clients tested | Claude Code, Claude Desktop |

Other MCP clients that support the MCP 1.0 protocol should work for all tools except `cedar_advise`, which additionally requires sampling support.

---

## Versioning policy

SemVer for v1.0+. Major versions may introduce breaking changes to tool input/output schemas. Minor versions add capabilities without breaking existing inputs. Patches are bug fixes.

The current version is `0.0.1` (pre-release). Pin to an exact version during the `0.x` line; breaking changes can happen between `0.x` releases.

---

## Examples

See [`examples/`](./examples/) for three full working scenarios with schemas, policies, entities, and copy-paste prompts:

- [`rbac-document-management`](./examples/rbac-document-management/) — role membership, `forbid` + `unless`, default deny
- [`abac-multi-tenant`](./examples/abac-multi-tenant/) — attribute conditions, `contains()`, optional attribute guards, plan-tier gating
- [`api-gateway-path-routing`](./examples/api-gateway-path-routing/) — path matching with `like`, depth limiting via negation, method restriction

Each example includes a `run.ts` that exercises all tools offline without an MCP client.

---

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

---

## License

Apache 2.0, same as Cedar itself. See [`LICENSE`](./LICENSE).

---

## Acknowledgments

- [Cedar team at AWS](https://github.com/cedar-policy/cedar) for the open-source Cedar engine and the `@cedar-policy/cedar-wasm` bindings
- [AWS Verified Permissions team](https://aws.amazon.com/verified-permissions/) for the production service this server complements
- [Anthropic MCP team](https://modelcontextprotocol.io) for the protocol and SDK
- Built by [Daniel Aniszkiewicz](https://builder.aws.com/community/heroes/DanielAniszkiewicz), AWS Hero
