# cedar-mcp-server

`cedar-mcp-server` is an MCP server that puts Cedar policy tooling directly inside your AI assistant conversation. It covers the full Cedar policy lifecycle: validate policies, simulate authorization decisions, plan changes against AVP constraints, and diff two policy stores for blue/green deployment. Cedar 4.11.0 runs in-process via WASM, so there's nothing to install beyond `npx`.

[![npm version](https://img.shields.io/npm/v/cedar-mcp-server)](https://www.npmjs.com/package/cedar-mcp-server)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

---

## What it does

Seventeen tools across six categories, plus three MCP prompts.

**Authorization** — make decisions: single requests or batches.

| Tool | What it does |
|------|-------------|
| [`cedar_authorize`](#cedar_authorize) | Evaluates one authorization request locally; returns the decision and which policies fired |
| [`cedar_authorize_batch`](#cedar_authorize_batch) | Runs N authorization requests through one policy set and returns the decision matrix; for regression testing after a policy edit |

**Validation** — confirm policies, schemas, templates, and entities are well-formed.

| Tool | What it does |
|------|-------------|
| [`cedar_validate`](#cedar_validate) | Validates Cedar policies against a schema; returns errors with hints and source locations |
| [`cedar_validate_schema`](#cedar_validate_schema) | Validates a Cedar schema in isolation (no policies required); returns parse errors and namespace/type counts |
| [`cedar_validate_template`](#cedar_validate_template) | Validates a Cedar template against a schema; detects slot placeholders |
| [`cedar_validate_entities`](#cedar_validate_entities) | Validates a Cedar entities JSON array against a schema; classifies errors by kind (unknown_type, missing_required_attribute, type_mismatch, unknown_attribute, disallowed_parent_type) |

**Formatting and translation** — transform policy/schema text without changing semantics.

| Tool | What it does |
|------|-------------|
| [`cedar_format`](#cedar_format) | Formats Cedar policy text to canonical style |
| [`cedar_translate`](#cedar_translate) | Translates between Cedar text and Cedar JSON formats for policies and schemas |

**Planning and analysis** — reason about policy design, changes, and intent.

| Tool | What it does |
|------|-------------|
| [`cedar_explain`](#cedar_explain) | Explains a Cedar policy in plain English with pattern detection |
| [`cedar_check_policy_change`](#cedar_check_policy_change) | Determines whether a policy modification can be applied in-place in AVP or requires delete-and-recreate |
| [`cedar_generate_sample_request`](#cedar_generate_sample_request) | Generates a complete authorization request payload that produces a target decision |
| [`cedar_advise`](#cedar_advise) | Translates a natural-language intent into a step-by-step Cedar policy change plan (uses MCP sampling) |

**Templates** — instantiate and inspect template-linked policies (template validation lives in **Validation**).

| Tool | What it does |
|------|-------------|
| [`cedar_link_template`](#cedar_link_template) | Instantiates a template by binding `?principal` and `?resource` slots to specific entity references |
| [`cedar_list_templates`](#cedar_list_templates) | Lists all templates in a policy store (reads from `templates/` subdirectory) |
| [`cedar_list_template_links`](#cedar_list_template_links) | Lists all template-linked policy instances in a store (reads from `template-links/` subdirectory) |

**Diffing** — compare two schemas or two policy stores before promoting changes.

| Tool | What it does |
|------|-------------|
| [`cedar_diff_schema`](#cedar_diff_schema) | Structural diff of two schemas with AVP-aware risk classification per change (safe/review/breaking) |
| [`cedar_diff_policy_stores`](#cedar_diff_policy_stores) | Structural and optional behavioral diff between two policy stores with AVP immutability classification (embeds structured `schema_diff` from `cedar_diff_schema`) |

---

## Quick start

> **Pre-release status:** this package is not yet published to npm. The `npx cedar-mcp-server` snippets below are the post-publish configuration; for now, install from source (see [Running from source](#running-from-source) below) and point your MCP client at the resulting local script instead of `npx`.

### Run from source (current path)

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

### Claude Code (after publish)

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

### Claude Desktop (after publish)

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

### Cursor (after publish)

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

### `cedar_authorize_batch`

Runs N authorization requests through ONE policy set and returns the decision matrix. Use case: regression testing after a policy edit (run a canonical request suite against the new policy set and confirm decisions haven't drifted).

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `policies` | one of | Inline Cedar policy text |
| `policy_ref` | one of | `cedar://` URI to load policies from a configured store |
| `schema` | no | Cedar schema (JSON or `.cedarschema`); when supplied, schema-violating requests resolve to `decision: "Error"` rather than silent Allow/Deny |
| `schema_ref` | no | `cedar://` URI to load schema |
| `requests` | yes | JSON array of authorization request objects: `{principal, action, resource, entities, context?}` |
| `entities` | no | Shared entities JSON applied when individual requests omit their own `entities` field |

**Output shape:**

```json
{
  "total": 200,
  "allowed": 162,
  "denied": 35,
  "errored": 3,
  "decisions": [
    {
      "index": 0,
      "principal": "DocMgmt::User::\"alice\"",
      "action": "DocMgmt::Action::\"READ\"",
      "resource": "DocMgmt::Document::\"doc-1\"",
      "decision": "Allow",
      "determining_policies": ["policy0"]
    }
  ],
  "summary": "200 requests: 162 Allow, 35 Deny, 3 Error"
}
```

Per-request errors carry an `error` field describing what went wrong (malformed entities, schema violation, etc.) without aborting the rest of the batch.

**When to use:** regression testing a canonical request suite after any policy edit. Pair with `cedar_diff_policy_stores`'s `behavioral_test_requests` when you also want a side-by-side comparison against the previous policy set.

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

Determines whether a policy modification can be applied in-place in Amazon Verified Permissions or requires delete-and-recreate.

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
| `format_preference` | no | `"structured"` (default) or `"narrative"`; hints the LLM at the desired output style |

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

### `cedar_validate_template`

Validates a Cedar template policy against a schema. Templates use slot placeholders (`?principal`, `?resource`) that are bound when the template is instantiated.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `template` | yes | Cedar template text, e.g. `permit(principal == ?principal, action == ..., resource == ?resource);` |
| `schema` | yes | Cedar schema (JSON or `.cedarschema` format) |

**Output shape:**

```json
{
  "valid": true,
  "errors": [],
  "warnings": [],
  "slots_detected": ["?principal", "?resource"]
}
```

**When to use:** after writing a new template, before adding it to your policy store. Also use to discover which slots a template exposes before calling `cedar_link_template`.

---

### `cedar_link_template`

Instantiates a Cedar template by binding its `?principal` and/or `?resource` slots to specific entity references. Returns the resulting Cedar policy text.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `template` | yes | Cedar template text |
| `principal` | no | Entity reference for the `?principal` slot, e.g. `App::User::"alice"` |
| `resource` | no | Entity reference for the `?resource` slot, e.g. `App::Document::"doc-42"` |
| `schema` | no | Cedar schema; if provided, the linked policy is validated against it |

**Output shape:**

```json
{
  "linked_policy": "permit(principal == App::User::\"alice\", action == App::Action::\"read\", resource == App::Document::\"doc-42\");",
  "slots_bound": {
    "?principal": "App::User::\"alice\"",
    "?resource": "App::Document::\"doc-42\""
  },
  "valid": true,
  "errors": []
}
```

**Note:** entity reference format is `Namespace::Type::"id"` — same as `cedar_authorize` principal/resource parameters.

**When to use:** instantiating a template to inspect the resulting policy or to validate it before deployment. For AVP, you'd upload the template once via `CreatePolicyTemplate` and create instances via `CreatePolicy` (template-linked variant) — `cedar_link_template` helps you reason about what those instances will look like before you make the API call.

---

### `cedar_list_templates`

Lists all Cedar template policies in a policy store. Templates live in a `templates/` subdirectory of the store root, following the same layout convention as `policies/`.

**Store layout with templates:**

```
my-store/
  policies/
    admin.cedar
  templates/
    viewer-access.cedar    <- permit(principal == ?principal, action == ..., resource == ?resource);
    editor-access.cedar
  template-links/
    alice-docs.json        <- { "template_id": "viewer-access", "slot_values": { ... } }
  schema.cedarschema
```

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `store` | yes | Store name (must be a configured MCP root) |

**Output shape:**

```json
{
  "store": "production",
  "templates": [
    {
      "id": "viewer-access",
      "content": "permit(principal == ?principal, ...);",
      "slots": ["?principal", "?resource"]
    }
  ]
}
```

**When to use:** discovering what templates exist in a store before instantiating or diffing them.

---

### `cedar_list_template_links`

Lists all template-linked policy instances in a store. Links live in a `template-links/` subdirectory. Each link is a JSON file recording which template it uses and the slot values bound to it.

**Template link file format** (`template-links/alice-docs.json`):

```json
{
  "template_id": "viewer-access",
  "slot_values": {
    "?principal": "App::User::\"alice\"",
    "?resource": "App::Document::\"doc-42\""
  }
}
```

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `store` | yes | Store name (must be a configured MCP root) |

**Output shape:**

```json
{
  "store": "production",
  "links": [
    {
      "id": "alice-docs",
      "template_id": "viewer-access",
      "slot_values": {
        "?principal": "App::User::\"alice\"",
        "?resource": "App::Document::\"doc-42\""
      }
    }
  ]
}
```

**When to use:** auditing which principal-resource pairs are covered by template-linked policies in a store, or diffing link coverage before a deployment.

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
  "schema_diff": {
    "namespaces_added": [],
    "namespaces_removed": [],
    "entity_types": { "added": [], "removed": [], "modified": [] },
    "actions": { "added": [], "removed": [], "modified": [] },
    "common_types": { "added": [], "removed": [], "modified": [] },
    "summary": "No schema changes detected.",
    "risk_level": "safe"
  },
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

The `schema_diff` field carries the full structured output of [`cedar_diff_schema`](#cedar_diff_schema). When schemas differ, expect entries in `entity_types`, `actions`, or `common_types` with `risk` classifications attached.

**When to use:** before promoting any policy changes from staging to production. The structural diff tells you what changed and how to deploy it. The behavioral diff tells you which authorization decisions would actually change.

---

### `cedar_validate_schema`

Validates a Cedar schema in isolation, without requiring any policies. Useful for the schema-first workflow: shape the entity model before writing the first policy.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `schema` | one of | Cedar schema text (JSON object or `.cedarschema` text). Format auto-detected. |
| `schema_ref` | one of | `cedar://schema/{store}` URI for a configured policy store. |

Exactly one of `schema` or `schema_ref` is required.

**Output shape:**

```json
{
  "valid": true,
  "format": "cedarschema",
  "namespaces": ["DocMgmt"],
  "entity_type_count": 4,
  "action_count": 3,
  "common_type_count": 0,
  "errors": []
}
```

When invalid:

```json
{
  "valid": false,
  "format": "cedarschema",
  "namespaces": [],
  "entity_type_count": 0,
  "action_count": 0,
  "common_type_count": 0,
  "errors": [
    {
      "message": "failed to parse schema from string: unexpected token `not`",
      "source_location": { "start": 0, "end": 3, "label": "expected `@`, `action`, `entity`, `namespace`, or `type`" }
    }
  ]
}
```

**When to use:**
- before writing the first policy — confirm the schema you sketched parses correctly
- before pushing schema changes to AVP via `PutSchema` — sanity-check syntactically
- as a fast check inside an agentic loop that's building a schema iteratively

---

### `cedar_diff_schema`

Structural diff of two Cedar schemas with AVP-aware risk classification per change. Replaces the hand-wavy "schemas differ, review carefully" pattern with a structured payload that says exactly what changed and how risky each change is for existing policies.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `blue` | yes | Baseline schema. Inline schema text (JSON or `.cedarschema`) OR a `cedar://schema/{store}` URI. |
| `green` | yes | Proposed schema. Same input forms as `blue`. |

The tool auto-detects `cedar://` URIs and resolves them via configured policy stores.

**Output shape:**

```json
{
  "namespaces_added": [],
  "namespaces_removed": [],
  "entity_types": {
    "added": [{ "namespace": "DocMgmt", "name": "Tag" }],
    "removed": [],
    "modified": [
      {
        "namespace": "DocMgmt",
        "name": "User",
        "attribute_changes": [
          {
            "attr": "phone",
            "change": "added",
            "new_type": "String",
            "risk": "breaking",
            "reason": "Required attribute added: existing entities/requests without this field will fail validation."
          }
        ]
      }
    ]
  },
  "actions": { "added": [], "removed": [], "modified": [] },
  "common_types": { "added": [], "removed": [], "modified": [] },
  "summary": "Schema diff: 1 entity type(s) added, 1 entity type(s) modified (1 BREAKING).",
  "risk_level": "breaking"
}
```

**Risk classification rules** — each change carries `risk: safe | review | breaking` plus a `reason` string. The rules:

| Change | Risk | Why |
|---|---|---|
| Entity type added | safe | No existing policy references it |
| Entity type removed | breaking | Policies referencing the type fail validation |
| Optional attribute added | safe | Existing policies don't reference it |
| Required attribute added | breaking | Existing entities lack the field |
| Attribute removed | breaking | Policies referencing it fail validation |
| Attribute type changed | breaking | Policies expecting the old type fail evaluation |
| Optional → required | breaking | Existing entities without the field fail |
| Required → optional | safe | Existing entities still satisfy the constraint |
| `memberOfTypes` added | review | Hierarchy widens; `in` checks may match more entities |
| `memberOfTypes` removed | breaking | Policies using `in` against removed parents fail |
| Action added | safe | No existing policy targets it |
| Action removed | breaking | Policies referencing it become invalid |
| Action `principalTypes` widened | review | Policy effect may change |
| Action `principalTypes` narrowed | breaking | Existing policies for the removed type fail |
| Action `resourceTypes` widened / narrowed | review / breaking | Same as principalTypes |
| Action context attribute follows entity-attribute rules | — | — |
| Common type added | safe | Nothing references it yet |
| Common type removed | review | If unreferenced, safe; if referenced, breaking. Audit. |
| Common type modified | review | Default to review; precise impact depends on references |

`risk_level` on the top-level result is the worst risk across all changes.

**When to use:**
- before promoting a schema change to production — see exactly what's at risk
- as the structured backbone of `cedar_diff_policy_stores` (embedded automatically there)
- inside an agentic policy review — let the agent reason about whether the schema change is deployable as-is

---

### `cedar_validate_entities`

Validates a Cedar entities JSON array against a schema, returning per-entity errors classified by kind. Useful for catching entity-store drift before it hits authorization at runtime.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `entities` | yes | JSON array of entity objects with `uid`, `attrs`, `parents` |
| `schema` | no | Cedar schema (JSON or `.cedarschema`) — enables type validation. Without it, only JSON shape is checked. |
| `schema_ref` | no | `cedar://schema/{store}` URI alternative to inline `schema` |

**Output shape:**

```json
{
  "valid": false,
  "entity_count": 1,
  "errors": [
    {
      "entity_uid": "DocMgmt::User::\"alice\"",
      "error_kind": "type_mismatch",
      "attribute": "name",
      "message": "entity does not conform to the schema: in attribute `name` on `DocMgmt::User::\"alice\"`, type mismatch: value was expected to have type string, but it actually has type long: `42`"
    }
  ]
}
```

`error_kind` is one of: `unknown_type`, `missing_required_attribute`, `type_mismatch`, `unknown_attribute`, `disallowed_parent_type`, `parse_error`, `other`. The `attribute` field is present for attribute-related errors. `disallowed_parent_type` fires when an entity's `parents` array contains a type the schema doesn't allow as an ancestor for that entity type.

**When to use:**
- when working with entity dumps from AVP `BatchGet` or custom entity stores
- before running `cedar_authorize` on a request that includes user-supplied entities — catch shape issues early
- inside a CI pipeline that publishes an entity snapshot — fail fast on drift

---

## MCP Prompts

In addition to tools, the server registers three MCP prompts that clients surface as slash commands or pre-canned message templates. Each prompt takes arguments, then returns an assembled message that drives the assistant through a structured Cedar workflow.

| Prompt | Arguments | What it does |
|--------|-----------|--------------|
| `cedar-review-policy-diff` | `blue_store` (required), `green_store` (required), `focus` (optional) | Drives `cedar_diff_policy_stores` + `cedar_diff_schema`, summarizes structural changes plus risk-classified schema diff, and recommends whether to promote. |
| `cedar-explain-denial` | `principal`, `action`, `resource`, `store` (all required) | Runs `cedar_authorize` against the store via `cedar://` refs, calls `cedar_explain` on the deciding policies, and produces a plain-English explanation of why the request was denied (or allowed) plus what would need to change. |
| `cedar-avp-migration-checklist` | `namespace` (optional) | Returns a guided checklist for migrating an AVP policy store: schema validation, entity format detection, single-namespace constraint, template-linked policies, schema diff before `PutSchema`, behavioral diff before traffic shift. Informational only — no tool calls assumed. |

In Claude Code these appear under the `/` slash menu when the server is configured. Other clients surface them differently per their UI conventions.

---

## Running as a shared HTTP server

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

### Endpoints

- `POST /mcp` — the MCP Streamable HTTP endpoint. Each session gets a unique `Mcp-Session-Id` returned on the initialize response and required on subsequent requests.
- `GET /health` — returns `{ status, transport, mode, active_sessions }` JSON. Useful for liveness probes.

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

Each MCP session DOES get its own `McpServer` instance — protocol state (initialized, message history, sampling) is per-session as the MCP spec requires.

### Security

- Default localhost binding plus the SDK's built-in DNS rebinding protection covers the local team-dev case.
- Non-localhost binding (`--host 0.0.0.0` or a public IP) is on you to secure. Recommended pattern: terminate TLS at a reverse proxy (nginx, Caddy, Cloudflare), add bearer-token or mTLS auth at that layer, forward the `POST /mcp` and `GET /health` paths to the server.
- v1 ships without built-in auth or CORS. Both are deferred until real demand surfaces.
- See `SECURITY.md` for the trust boundary and input validation guarantees.

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

Both `policy_ref` and `schema_ref` accept these URIs in `cedar_validate` and `cedar_authorize`. Inline text still works — pass either form.

### Error when no stores are configured

If you call `cedar_diff_policy_stores` or use a `cedar://` reference but haven't configured roots, the error message explains the expected directory layout and how to configure roots in your MCP client settings.

---

## Coming from Amazon Verified Permissions?

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

### Schema and entity workflows

These tools are useful when you are working directly with AVP schema and entity data.

**`cedar_validate_schema`**: Validates a Cedar schema JSON for structural correctness before you call AVP `PutSchema`. Run this as a pre-flight check: if the schema is malformed, `cedar_validate_schema` tells you the exact error before AVP rejects it.

**`cedar_diff_schema`**: Computes a structural diff between two schemas and classifies each change as `safe`, `review`, or `breaking`. A `risk: breaking` change means existing policies will fail validation against the new schema. Use this when comparing schemas across two AVP policy stores, or when planning a `PutSchema` deployment and you want to know what you are changing and at what risk level before committing.

**`cedar_validate_entities`**: Validates an entity-store JSON against a schema. When you retrieve entities from AVP via `BatchGetPolicyStoreEntities` (or build them manually), run this before passing them to `cedar_authorize`. It catches type mismatches and missing required attributes early, so authorization failures have a clear cause.

### Template-linked policies

AVP uses template-linked policies heavily. A template has `?principal` and `?resource` slots; each link binds those slots to specific entity references to produce a concrete policy. The template body is immutable once created; only the slot bindings change per link.

**`cedar_validate_template`**: Validates a Cedar policy template against a schema. Detects `?principal` and `?resource` slot presence and reports schema errors. Run this before uploading a new template to AVP via `CreatePolicyTemplate`.

**`cedar_link_template`**: Instantiates a template by binding `?principal` and `?resource` to specific entity references. The output is a Cedar-format policy string. You can then pass that to `cedar_check_policy_change` to diff it against an existing policy, or use it as the body for an AVP `CreatePolicy` (static) call.

**`cedar_list_templates`**: Lists templates from the configured policy store (`templates/*.cedar` subdirectory). Useful when auditing which templates exist in a store before deploying changes.

**`cedar_list_template_links`**: Lists template links from the configured policy store (`template-links/*.json` subdirectory). Each link record shows which entity refs are bound to a given template. Use this to audit coverage: which principals and resources have active template-linked policies.

When updating a template-linked policy in AVP, the binding (slot values) can change via `UpdatePolicy`, but the template body can only change via `UpdatePolicyTemplate`, which invalidates all links. Use `cedar_check_policy_change` to verify the impact of a template body change before calling `UpdatePolicyTemplate`.

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
| Validate a template policy | — | `cedar_validate_template` |
| Instantiate a template (bind slots) | — | `cedar_link_template` |
| List templates / links in a store | — | `cedar_list_templates`, `cedar_list_template_links` |

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

## Known limitations

This server runs Cedar 4.11.0 through `@cedar-policy/cedar-wasm`. That WASM package does not expose Cedar's symbolic-analysis backend (`cedar-policy-symcc`), so the following capabilities are NOT available in this server:

- **Semantic equivalence between two policy sets.** "Do these two policy sets produce the same decision for every well-formed request?" `cedar_diff_policy_stores` performs a structural diff plus an optional behavioral diff over a request matrix you supply, but neither proves logical equivalence.
- **Full shadowing detection.** `cedar_diff_policy_stores` and Cedar's own `validate` surface some shadowing cases, but a complete pairwise shadowing analysis (does policy A's match condition imply policy B's?) requires SMT.
- **Full reachability / dead-policy analysis.** Cedar's WASM `validate` surfaces dead policies that fail trivially (schema-mismatched scopes, literal-folding unsat such as `when { 1 == 2 }`, type-incompatible expressions). It does not catch attribute-value contradictions like `when { age > 18 && age < 10 }`.
- **`never-errors` verification.** Proving that a policy can never produce a runtime error.

Cedar's official CLI ships these as 11 verification subcommands under `cedar symcc`, but only when built with `cargo install cedar-policy-cli --features analyze` and used together with the CVC5 SMT solver. That install chain is incompatible with the `npx`-only positioning of this server, so the SMT tools are not bundled today.

**Future direction:** if upstream Cedar exposes `cedar-policy-symcc` through `@cedar-policy/cedar-wasm`, the equivalent tools land here directly. Otherwise a companion package (e.g. `cedar-mcp-server-analyze`) that shells out to a locally-installed `cedar symcc` is the most likely path. No timeline.

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
- [Amazon Verified Permissions team](https://aws.amazon.com/verified-permissions/) for the production service this server complements
- [Anthropic MCP team](https://modelcontextprotocol.io) for the protocol and SDK
- Built by [Daniel Aniszkiewicz](https://builder.aws.com/community/heroes/DanielAniszkiewicz), AWS Hero
