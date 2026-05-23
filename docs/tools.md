# Tool reference

Detailed reference for all 17 `cedar_*` tools. Each section includes purpose, inputs, an example prompt to paste into your MCP client, and the captured JSON response. For the high-level tool-by-category index, see [`README.md`](../README.md#whats-inside).

Every example below assumes a Cedar workspace store called `cedar-sandbox`: a directory with `schema.cedarschema` declaring a `MyApp` namespace (User, Role, Document, Folder entities; read / write / delete actions), per-file policies in `policies/` (`admin.cedar`, `editor.cedar`, `viewer.cedar`), and an `entities/sample.json` containing alice (admin), bob (editor), charlie (viewer) plus a `doc-public` document. Substitute your own store name in any example prompt that mentions `cedar-sandbox`. For complete worked fixtures, see [`../examples/`](../examples/).

---

### `cedar_validate`

Validates Cedar policies with or without a schema. Two modes:

- **Syntax-only** (no schema): runs the parser alone. Catches typos, malformed scopes, bad operators. Cheapest sanity check, useful when you have a 5-line snippet and no schema yet.
- **Syntax-and-schema** (schema provided): parses then type-checks against the schema. Catches attribute typos, entity type mismatches, action applicability errors, and `UnsafeOptionalAttributeAccess` warnings.

The response's `validation_mode` field tells you which mode ran.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `policies` | yes (or `policy_ref`) | Cedar policy text (one or more policies) |
| `schema` | no | Cedar schema (JSON object or `.cedarschema` text). Omit for syntax-only mode or to auto-discover from the workspace store. |
| `policy_ref` | no | `cedar://` URI pointing to a policy in a configured store |
| `schema_ref` | no | `cedar://` URI pointing to a schema in a configured store |
| `store` | no | Store name (a configured MCP root). Use to disambiguate auto-discovery when multiple stores are loaded. |
| `validation_mode` | no | One of `"auto"` (default), `"syntax_only"`, or `"syntax_and_schema"`. See "Forcing a mode" below. |

**Workspace auto-discovery.** When `schema` and `schema_ref` are both omitted and exactly one MCP root is loaded, the tool reads the schema from that store and upgrades the run to `syntax_and_schema` mode. The response's `auto_discovered.schema_from` field names the source store. With multiple stores loaded, the response is an actionable error listing the candidate names. Pass `store: "<name>"` to choose one.

**Forcing a mode.** Set `validation_mode` when the default schema-presence heuristic isn't what you want.

- `"auto"` (default): schema presence picks the mode, as described above.
- `"syntax_only"`: parser-only. Skips workspace auto-discovery entirely and ignores any inline schema, `schema_ref`, or `store` you pass alongside it (the user said parser-only; the tool honors that literally). Use when the user explicitly says they have no schema, or for a fast parse-only sanity check inside a Cedar-workspace cwd.
- `"syntax_and_schema"`: require a schema. If neither an inline schema nor a workspace schema is resolvable, the response is an error rather than a silent drop to syntax-only. Use when you want to be sure the type-check ran.

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
Use cedar_validate on: permit (prinicpal in MyApp::Role::"admin", action, resource);
```

**Response:**

```json
{
  "valid": false,
  "errors": [
    {
      "policy_id": "",
      "message": "failed to parse policies from string: found an invalid variable in the policy scope: prinicpal",
      "hint": "Did you mean 'principal'?",
      "line": 1,
      "column": 9
    }
  ],
  "warnings": [],
  "policy_count": 0,
  "validation_mode": "syntax_and_schema",
  "auto_discovered": { "schema_from": "cedar-sandbox" }
}
```

The typo `prinicpal` lands on the schema-aware path because the cwd-fallback auto-discovered the sandbox schema, so `validation_mode` is `syntax_and_schema`. With no workspace store loaded (or `validation_mode: "syntax_only"` set explicitly), the same prompt produces the same parse error but `validation_mode: "syntax_only"` and no `auto_discovered` field.

Additional shapes you'll see:

```json
// Schema-validation error: attribute not declared on the entity type
{
  "valid": false,
  "errors": [
    {
      "policy_id": "policy0",
      "message": "attribute `nonexistent` on entity type `MyApp::Document` not found",
      "hint": "did you mean `classification`?",
      "line": 1,
      "column": 47
    }
  ],
  "policy_count": 1,
  "validation_mode": "syntax_and_schema"
}
```

```json
// Parse error on a multi-line policy with `int` instead of `in` on line 3
{
  "valid": false,
  "errors": [
    {
      "policy_id": "",
      "message": "failed to parse policies from string: unexpected token `int`",
      "hint": "Did you mean 'in'?",
      "line": 3,
      "column": 10
    }
  ],
  "policy_count": 0,
  "validation_mode": "syntax_and_schema"
}
```

Each error includes `line` and `column` (1-indexed) derived from the WASM parser's source location when available. The `hint` field is populated either from Cedar's own diagnostic help text or from a small built-in typo table for common misspellings (`int` for `in`, `permint` for `permit`, `prinicpal` / `prinipal` for `principal`, `wen` for `when`, `unles` for `unless`, etc.). When neither applies, `hint` is `null`.

**When to use:** every time you write or modify a policy. Syntax-only mode is the fast first pass when iterating on a snippet. Full schema validation catches attribute typos, entity type mismatches, and action applicability errors before they become silent runtime surprises.

---

### `cedar_authorize`

Evaluates an authorization request locally against your policies and entities. Returns the decision and which policies fired.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `policies` | yes (or `policy_ref`, or auto-discovered) | Cedar policy text |
| `principal` | yes | Entity reference, e.g. `MyApp::User::"alice"` |
| `action` | yes | Entity reference, e.g. `MyApp::Action::"read"` |
| `resource` | yes | Entity reference, e.g. `MyApp::Document::"doc-public"` |
| `entities` | yes (or `entities_ref`, or auto-discovered) | JSON array of entity objects (uid, attrs, parents) |
| `schema` | no (or `schema_ref`, or auto-discovered) | Cedar schema; enables request validation |
| `context` | no | JSON object with context attributes |
| `policy_ref` | no | `cedar://` URI for policy store reference |
| `schema_ref` | no | `cedar://` URI for schema reference |
| `entities_ref` | no | `cedar://` URI for an entities file reference |
| `store` | no | Store name (a configured MCP root). Use to disambiguate auto-discovery when multiple stores are loaded. |

**Workspace auto-discovery.** When any of `policies` / `schema` / `entities` (and their `_ref` siblings) are omitted and exactly one MCP root is loaded, the tool reads each missing input from that store: `policies/*.cedar` files (per-policy basenames preserved as determining-policy IDs), `schema.cedarschema` or `schema.json`, and the entities under `entities/*.json` merged into one array. The response's `auto_discovered` field reports which store satisfied each missing input. With multiple stores loaded, the response is an actionable error listing the candidate names. Pass `store: "<name>"` to choose one.

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
Can alice read doc-public?
```

The assistant translates this to a cedar_authorize call with `principal: MyApp::User::"alice"`, `action: MyApp::Action::"read"`, `resource: MyApp::Document::"doc-public"`. Policies, schema, and entities all auto-discover from the sandbox.

**Response:**

```json
{
  "decision": "Allow",
  "determining_policies": ["admin"],
  "errors": [],
  "decision_reason": "permit_policy_fired",
  "format_detected": "cedar",
  "format_note": "Input is in Cedar/WASM format.",
  "auto_discovered": {
    "policies_from": "cedar-sandbox",
    "schema_from": "cedar-sandbox",
    "entities_from": "cedar-sandbox"
  }
}
```

`determining_policies: ["admin"]` is the file basename (`policies/admin.cedar` → `admin`), not a positional placeholder, because cedar_authorize uses the H1 stable-ID resolution ladder described below.

Additional shapes:

```json
// Deny via default-deny (no policy matched)
{
  "decision": "Deny",
  "determining_policies": [],
  "errors": [],
  "decision_reason": "default_deny_no_permit_matched"
}
```

```json
// Deny via a forbid policy
{
  "decision": "Deny",
  "determining_policies": ["editor_readonly"],
  "errors": [],
  "decision_reason": "forbid_policy_fired"
}
```

`determining_policies` lists the stable policy IDs that contributed to the decision. The ID resolution order is: the policy's `@id("name")` annotation if present, then the source file basename when policies are loaded via `policy_ref` (e.g. `admin.cedar` becomes `admin`), then a positional fallback `policy0`, `policy1`, etc. for unannotated inline text. On a deny caused by a `forbid` policy, that policy's ID appears here. An empty list means default deny: no `permit` matched.

`decision_reason` is an explicit machine-readable classification of the outcome. It takes one of four values:

- `permit_policy_fired` when `decision: "Allow"` and at least one permit policy is determining.
- `forbid_policy_fired` when `decision: "Deny"` and at least one forbid policy is determining.
- `default_deny_no_permit_matched` when `decision: "Deny"`, no policy fired, and no evaluation errors occurred. This is the Cedar default-deny path.
- `evaluation_error` when at least one policy errored during evaluation (for example, a policy reads an attribute the entity lacks). Pair with the `errors` array for details.

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
| `entities_ref` | no | `cedar://` URI to load shared entities |

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
Run a batch of three authorizations against the sandbox: alice/read/doc-public, bob/write/doc-public, charlie/delete/doc-public.
```

The assistant translates this to a cedar_authorize_batch call referencing `cedar://policies/cedar-sandbox`, `cedar://schema/cedar-sandbox`, and `cedar://entities/cedar-sandbox`, with the three requests inline.

**Response:**

```json
{
  "total": 3,
  "allowed": 2,
  "denied": 1,
  "errored": 0,
  "decisions": [
    {
      "index": 0,
      "principal": "MyApp::User::\"alice\"",
      "action": "MyApp::Action::\"read\"",
      "resource": "MyApp::Document::\"doc-public\"",
      "decision": "Allow",
      "determining_policies": ["admin"]
    },
    {
      "index": 1,
      "principal": "MyApp::User::\"bob\"",
      "action": "MyApp::Action::\"write\"",
      "resource": "MyApp::Document::\"doc-public\"",
      "decision": "Allow",
      "determining_policies": ["editor"]
    },
    {
      "index": 2,
      "principal": "MyApp::User::\"charlie\"",
      "action": "MyApp::Action::\"delete\"",
      "resource": "MyApp::Document::\"doc-public\"",
      "decision": "Deny",
      "determining_policies": []
    }
  ],
  "summary": "3 requests: 2 Allow, 1 Deny, 0 Error"
}
```

Per-request errors carry an `error` field describing what went wrong (malformed entities, schema violation, etc.) without aborting the rest of the batch.

`determining_policies` returns file basenames (`admin`, `editor`) when policies are loaded from a `cedar://policies/{store}` ref, matching the H1 stable-ID resolution that single-request `cedar_authorize` uses. Inline policies passed as a flat string still surface as `policy0` / `policy1` (positional fallback) because the caller did not supply basenames.

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

**Example prompt** (paste into Claude Code):

```
Format this Cedar: permit(principal in MyApp::Role::"admin",action,resource);
```

**Response:**

```json
{
  "formatted": "permit (\n  principal in MyApp::Role::\"admin\",\n  action,\n  resource\n);\n",
  "error": null
}
```

The `formatted` field is the canonical-style Cedar text. The same input applied to the formatter is idempotent (already-canonical text returns unchanged).

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

**Example prompt** (paste into Claude Code):

```
Translate to JSON: permit (principal, action, resource);
```

**Response:**

```json
{
  "output": "{\n  \"effect\": \"permit\",\n  \"principal\": {\n    \"op\": \"All\"\n  },\n  \"action\": {\n    \"op\": \"All\"\n  },\n  \"resource\": {\n    \"op\": \"All\"\n  },\n  \"conditions\": []\n}",
  "error": null
}
```

The `output` field is the Cedar JSON-AST representation of the policy. Round-trip back via `direction: "to_cedar"` to recover the source.

**When to use:** programmatic policy inspection, generating policies from code, or feeding policy structure into tools that work with JSON.

---

### `cedar_explain`

Explains a Cedar policy in plain English with pattern detection.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `policy` | yes | A single Cedar policy (not a policy set) |
| `schema` | no | Cedar schema; improves entity type descriptions |
| `schema_ref` | no | `cedar://` URI for schema reference |
| `store` | no | Store name (a configured MCP root). Use to disambiguate auto-discovery when multiple stores are loaded. |

**Workspace auto-discovery.** When `schema` and `schema_ref` are both omitted and exactly one MCP root is loaded, the tool reads the schema from that store. The response's `auto_discovered.schema_from` field names the source store. The schema is optional for explain, so a single store with no schema file still produces a result. With multiple stores loaded and no `store` parameter, the response is an actionable error listing the candidate names.

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
Explain this policy: permit (principal in MyApp::Role::"admin", action, resource);
```

**Response:**

```json
{
  "effect": "permit",
  "principal": {
    "scope": "in",
    "description": "principal in MyApp::Role::\"admin\""
  },
  "action": {
    "scope": "All",
    "description": "any action"
  },
  "resource": {
    "scope": "All",
    "description": "any resource"
  },
  "conditions": [],
  "summary": "PERMITS principal in MyApp::Role::\"admin\" to perform any action on any resource.",
  "patterns_detected": [
    "role_based_access",
    "unrestricted_action",
    "unrestricted_resource"
  ],
  "auto_discovered": {
    "schema_from": "cedar-sandbox"
  }
}
```

The `patterns_detected` array names recognizable shapes the tool spotted in the AST: `role_based_access` for membership in a Role, `unrestricted_action` / `unrestricted_resource` for `All`-scope clauses, `attribute_condition` when `when`/`unless` reads attributes, `forbid_policy` for forbid effects, etc.

**When to use:** onboarding teammates onto an existing policy set, auditing policies you didn't write, or explaining the intent behind a complex `when`/`unless` combination.

---

### `cedar_check_policy_change`

Determines whether a policy modification can be applied in-place in Amazon Verified Permissions or requires delete-and-recreate.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `old_policy` | yes | Existing Cedar policy text |
| `new_policy` | yes | Updated Cedar policy text |

**Example prompt** (paste into Claude Code):

```
Check this change: editor.cedar narrows from `action in [read, write]` to `action == read`.
```

The assistant translates this to a cedar_check_policy_change call with `old_policy` = the read+write permit, `new_policy` = the read-only permit (both in the MyApp namespace).

**Response:**

```json
{
  "can_update_in_place": true,
  "changes": [
    {
      "field": "action",
      "old_value": "{\"op\":\"in\",\"entities\":[{\"type\":\"MyApp::Action\",\"id\":\"read\"},{\"type\":\"MyApp::Action\",\"id\":\"write\"}]}",
      "new_value": "{\"op\":\"==\",\"entity\":{\"type\":\"MyApp::Action\",\"id\":\"read\"}}",
      "in_place_allowed": true,
      "reason": "Action clause changes can be applied in-place."
    }
  ],
  "recommendation": "All changes can be applied as an in-place policy update."
}
```

An example where the diff requires delete-and-recreate instead:

```json
// old_policy changed the principal head clause (e.g. viewer → senior_viewer)
{
  "can_update_in_place": false,
  "changes": [
    {
      "field": "principal",
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
| `effect` | No (delete and recreate) |
| `principal` | No (delete and recreate) |
| `resource` | No (delete and recreate) |
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

**Example prompt** (paste into Claude Code):

```
Generate a sample request that would be allowed by: permit (principal in MyApp::Role::"admin", action, resource);
```

The assistant translates this to a cedar_generate_sample_request call with the policy text and the cedar-sandbox schema.

**Response:**

```json
{
  "principal": "MyApp::User::\"sample-principal\"",
  "action": "MyApp::Action::\"delete\"",
  "resource": "MyApp::Document::\"sample-resource\"",
  "entities": [
    {
      "uid": { "type": "MyApp::User", "id": "sample-principal" },
      "attrs": { "email": "", "name": "" },
      "parents": [{ "type": "MyApp::Role", "id": "admin" }]
    },
    {
      "uid": { "type": "MyApp::Document", "id": "sample-resource" },
      "attrs": { "classification": "", "owner": "" },
      "parents": []
    },
    {
      "uid": { "type": "MyApp::Role", "id": "admin" },
      "attrs": {},
      "parents": []
    }
  ],
  "explanation": "This request will be ALLOW as expected.",
  "decision": "Allow",
  "ready_to_test": true
}
```

The generator pre-fills required attributes from the schema (`name`, `email` on User; `classification`, `owner` on Document) with neutral defaults so `validateRequest: true` accepts the payload. The verification step runs the generated request through `cedar_authorize` with the same schema; `ready_to_test: true` means a follow-up call with these exact inputs reproduces the documented `decision`. If the verification fails (most commonly when the policy pins an entity type the schema does not declare), the response carries `ready_to_test: false` and a non-null `error` instead.

**When to use:** generating test payloads without hand-crafting entities, or verifying that a policy produces the decisions you expect before deploying it. Pass the output directly to `cedar_authorize` to verify.

---

### `cedar_advise`

Returns a deterministic, structured context bundle for any "I want to change my Cedar policies to do X" intent. The bundle encodes the Cedar / AVP knowledge that does not live in the policy files: AVP `UpdatePolicy` mutability rules, AVP validation error categories, the 10-entry gotcha catalog (with the subset selected by the user's intent keywords), the Cedar patterns reference, AST-based pattern classification of every policy in the store, and explicit sequencing + follow-up guidance.

The tool itself does not produce the plan. The calling assistant produces the plan from the bundle, then verifies each Cedar snippet with `cedar_validate` and each modification with `cedar_check_policy_change`. No MCP sampling, no client LLM round-trip on the server side.

This pivot replaced the original sampling-based `cedar_advise` after dogfooding revealed two problems: (1) Claude Code does not advertise the MCP `sampling` capability, so the prior tool returned `-32601 Method not found`; (2) when the assistant fell back to drafting from file Read alone, it bypassed the server entirely and lost the AVP/gotcha grounding the server is supposed to provide. The bundle design defeats both.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `intent` | yes | Natural-language description of the desired authorization behavior, kept verbatim from the user |
| `store_ref` | no | Store name or `cedar://` URI (e.g. `cedar://policies/production` or `production`); when supplied, the bundle includes `schema_summary`, `policy_inventory` with full policy text, and `patterns_detected_in_store` counts grounded in the actual store. Omit when exactly one store is loaded and the bundle will auto-resolve to it (the response's `auto_discovered.store_from` field reports `"single_loaded_store"`). With multiple stores loaded and no `store_ref`, the response sets `store_status: "ambiguous"` and lists the candidate names under `available_stores`. |

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
I want to make editors read-only, admins exempt. Plan it.
```

The assistant translates this to a cedar_advise call with `intent: "Make editors read-only, admins exempt."` and no `store_ref` (cedar-sandbox is the only loaded store, so it auto-resolves).

**Response (abridged):**

```json
{
  "tool": "cedar_advise",
  "bundle_version": "v2",
  "intent": "Make editors read-only, admins exempt.",
  "store_name": "cedar-sandbox",
  "store_status": "loaded",
  "auto_discovered": { "store_from": "single_loaded_store" },
  "schema_summary": {
    "valid": true,
    "format": "cedarschema",
    "namespaces": ["MyApp"],
    "entity_type_count": 4,
    "action_count": 3,
    "raw_text": "namespace MyApp { ... }"
  },
  "policy_inventory": [
    {
      "policy_id": "admin",
      "pattern": "membership",
      "pattern_confidence": "high",
      "summary": "admin (permit, principal scope uses 'in' — group/role membership (RBAC))",
      "policy_text": "permit (principal in MyApp::Role::\"admin\", action, resource);"
    },
    { "policy_id": "editor", "pattern": "membership", "...": "..." },
    { "policy_id": "viewer", "pattern": "membership", "...": "..." }
  ],
  "patterns_detected_in_store": [{ "pattern": "membership", "count": 3 }],
  "applicable_gotchas": [
    {
      "id": "array_containment_syntax",
      "severity": "medium",
      "description": "Cedar array containment is left-first: `[\"a\", \"b\"].contains(attr)` — the ARRAY is on the left. Writing `attr in [\"a\", \"b\"]` is an entity-hierarchy check, not a value containment check."
    }
  ],
  "avp_update_policy_rules": {
    "summary": "...",
    "in_place_via_update_policy": ["Action scope", "When/unless conditions", "Policy name"],
    "requires_delete_recreate": ["Effect", "Principal scope", "Resource scope", "Static ↔ template-linked conversion"],
    "new_via_create_policy": ["Wholly new policy"],
    "notes": ["UpdatePolicy only updates STATIC policies..."]
  },
  "avp_validation_error_catalog": [
    { "id": "UnsafeOptionalAttributeAccess", "description": "..." }
  ],
  "cedar_patterns_reference": {
    "summary": "...",
    "patterns": [
      { "name": "Membership (RBAC)", "description": "...", "example": "..." }
    ]
  },
  "sequencing_guidance": [
    "Schema changes that add new entity types, attributes, or actions MUST be deployed BEFORE policies that reference them..."
  ],
  "next_steps_for_llm": "Use this context to produce a Cedar policy change plan. Do not skip these steps: 1. Identify the entity types... 6. After drafting Cedar snippets, call cedar_validate on each... 7. For each modification to an existing policy, call cedar_check_policy_change..."
}
```

The main example above shows the **auto-resolve** path (one store loaded, no `store_ref` passed). When multiple stores are loaded and no `store_ref` is passed, the response shape is **ambiguous** instead:

```json
{
  "tool": "cedar_advise",
  "bundle_version": "v2",
  "intent": "Make editors read-only, admins exempt.",
  "store_status": "ambiguous",
  "available_stores": ["blue", "green"],
  "policy_inventory": [],
  "patterns_detected_in_store": [],
  "...": "universal Cedar / AVP context still present"
}
```

The calling LLM should ask the user which store and re-invoke with an explicit `store_ref`. The `next_steps_for_llm` field in the response includes this guidance.

**When to use:** at the start of any policy-change conversation, before recommending any Cedar snippet. Call this once per intent; iterate the plan in conversation rather than re-calling for small refinements (the bundle is the same for a given intent + store).

When you have more than one store loaded, name your policy store in the prompt (for example, "plan this change against my cedar-sandbox store" or "modify policies in production"). With a store name, the bundle grounds in your actual schema, full policy inventory, and detected patterns. If exactly one store is loaded the bundle auto-resolves to it (you'll see `auto_discovered.store_from: "single_loaded_store"`). If multiple stores are loaded and you don't pass `store_ref`, `store_status` is `"ambiguous"` and `available_stores` lists the candidates so you can retry. If no stores are loaded at all, `store_status` is `"not_provided"` and the bundle returns the generic Cedar / AVP context only.

---

### `cedar_validate_template`

Validates a Cedar template policy against a schema. Templates use slot placeholders (`?principal`, `?resource`) that are bound when the template is instantiated.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `template` | yes | Cedar template text, e.g. `permit(principal == ?principal, action == ..., resource == ?resource);` |
| `schema` | yes | Cedar schema (JSON or `.cedarschema` format) |

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
Validate this Cedar template against the sandbox schema:
permit (principal == ?principal, action == MyApp::Action::"read", resource == ?resource);
```

The assistant translates this to a cedar_validate_template call with the template text and the inline schema from `cedar-sandbox/schema.cedarschema`.

**Response:**

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

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
Link this template with alice + doc-public, validated against the sandbox schema:
permit (principal == ?principal, action == MyApp::Action::"read", resource == ?resource);
```

**Response:**

```json
{
  "linked_policy": "permit(principal == MyApp::User::\"alice\", action == MyApp::Action::\"read\", resource == MyApp::Document::\"doc-public\");",
  "slots_bound": {
    "?principal": "MyApp::User::\"alice\"",
    "?resource": "MyApp::Document::\"doc-public\""
  },
  "valid": true,
  "errors": []
}
```

Entity reference format is `Namespace::Type::"id"`, same as `cedar_authorize`'s principal / resource parameters.

**When to use:** instantiating a template to inspect the resulting policy or to validate it before deployment. For AVP, you upload the template once via `CreatePolicyTemplate` and create instances via `CreatePolicy` (template-linked variant); `cedar_link_template` helps you reason about what those instances will look like before you make the API call.

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

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
List templates in the cedar-sandbox store.
```

**Response:**

```json
{
  "store": "cedar-sandbox",
  "templates": []
}
```

The sandbox has no `templates/` subdirectory, so the array is empty. With templates present in a store, each entry includes `id` (filename basename without `.cedar`), `content` (the template text), and `slots` (the `?principal` / `?resource` placeholders detected by parsing the template).

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

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
List template links in the cedar-sandbox store.
```

**Response:**

```json
{
  "store": "cedar-sandbox",
  "links": []
}
```

The sandbox has no `template-links/` subdirectory, so the array is empty. With links present, each entry includes `id` (filename basename without `.json`), `template_id`, and `slot_values`.

**When to use:** auditing which principal-resource pairs are covered by template-linked policies in a store, or diffing link coverage before a deployment.

---

### `cedar_diff_policy_stores`

Structural and optional behavioral diff between two policy stores. Requires MCP Roots configured (see [Configure policy stores](./getting-started.md#configure-policy-stores-mcp-roots)).

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `blue` | yes | Store name for the base (e.g. `"production"`) |
| `green` | yes | Store name for the proposed changes (e.g. `"staging"`) |
| `behavioral_test_requests` | no | JSON string of authorization requests to run through both stores; surfaces decision drift |

**Output shape:**

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
Diff the cedar-sandbox store against itself (smoke test the tool shape).
```

The assistant translates this to a cedar_diff_policy_stores call with `blue: "cedar-sandbox"`, `green: "cedar-sandbox"`. A real promotion run would compare distinct stores (e.g. `blue: "production"`, `green: "staging"`); see [Configure policy stores](./getting-started.md#configure-policy-stores-mcp-roots) for multi-store configuration.

**Response:**

```json
{
  "blue": "cedar-sandbox",
  "green": "cedar-sandbox",
  "policies_added": [],
  "policies_removed": [],
  "policies_modified": [],
  "schema_diff": {
    "namespaces_added": [],
    "namespaces_removed": [],
    "entity_types": { "added": [], "removed": [], "modified": [] },
    "actions": { "added": [], "removed": [], "modified": [] },
    "common_types": { "added": [], "removed": [], "modified": [] },
    "summary": "No schema changes detected.",
    "risk_level": "safe"
  },
  "summary": "No changes detected between blue and green stores."
}
```

With real differences between the two stores, `policies_added` / `policies_removed` / `policies_modified` carry per-policy details (the same `can_update_in_place` + `changes` shape as `cedar_check_policy_change`), and `schema_diff` carries the full structured output of [`cedar_diff_schema`](#cedar_diff_schema). When `behavioral_test_requests` is supplied, the response also includes a `behavioral_diff` array of per-request `blue_decision` vs `green_decision` entries with a `drifted` boolean flagging differences.

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

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
Validate the cedar-sandbox schema.
```

The assistant translates this to a cedar_validate_schema call with `schema_ref: "cedar://schema/cedar-sandbox"`.

**Response:**

```json
{
  "valid": true,
  "format": "cedarschema",
  "namespaces": ["MyApp"],
  "entity_type_count": 4,
  "action_count": 3,
  "common_type_count": 0,
  "errors": []
}
```

When invalid, the same shape carries `valid: false`, zeroed counts, and an `errors` array with `message` plus a `source_location` block:

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
- before writing the first policy, to confirm the schema you sketched parses correctly
- before pushing schema changes to AVP via `PutSchema`, as a syntactic sanity check
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

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
Diff the cedar-sandbox schema against a proposed schema that adds a verified_email: Bool attribute to User.
```

The assistant translates this to a cedar_diff_schema call with `blue: "cedar://schema/cedar-sandbox"` and `green` set to the sandbox schema text with `verified_email: Bool,` inserted into the User entity.

**Response:**

```json
{
  "namespaces_added": [],
  "namespaces_removed": [],
  "entity_types": {
    "added": [],
    "removed": [],
    "modified": [
      {
        "namespace": "MyApp",
        "name": "User",
        "attribute_changes": [
          {
            "attr": "verified_email",
            "change": "added",
            "new_type": "Bool",
            "risk": "breaking",
            "reason": "Required attribute added: existing entities/requests without this field will fail validation."
          }
        ]
      }
    ]
  },
  "actions": { "added": [], "removed": [], "modified": [] },
  "common_types": { "added": [], "removed": [], "modified": [] },
  "summary": "Schema diff: 1 entity type(s) modified (1 BREAKING).",
  "risk_level": "breaking"
}
```

The `risk: "breaking"` classification fires because adding a *required* attribute to an existing entity type invalidates every entity payload that doesn't already carry the new field. To deploy this safely, make the attribute optional first, backfill values, then tighten to required.

**Risk classification rules.** Each change carries `risk: safe | review | breaking` plus a `reason` string. The rules:

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
| Action context attribute follows entity-attribute rules | (see above) | (see above) |
| Common type added | safe | Nothing references it yet |
| Common type removed | review | If unreferenced, safe; if referenced, breaking. Audit. |
| Common type modified | review | Default to review; precise impact depends on references |

`risk_level` on the top-level result is the worst risk across all changes.

**When to use:**
- before promoting a schema change to production, to see exactly what's at risk
- as the structured backbone of `cedar_diff_policy_stores` (embedded automatically there)
- inside an agentic policy review, so the agent can reason about whether the schema change is deployable as-is

---

### `cedar_validate_entities`

Validates a Cedar entities JSON array against a schema, returning per-entity errors classified by kind. Useful for catching entity-store drift before it hits authorization at runtime.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `entities` | yes | JSON array of entity objects with `uid`, `attrs`, `parents` |
| `schema` | no | Cedar schema (JSON or `.cedarschema`); when supplied, enables type validation. Without it, only JSON shape is checked. |
| `schema_ref` | no | `cedar://schema/{store}` URI alternative to inline `schema` |

**Example prompt** (paste into Claude Code from a Cedar workspace):

```
Validate the entities in cedar-sandbox against its schema.
```

The assistant translates this to a cedar_validate_entities call with the entities payload inline (read from `cedar-sandbox/entities/sample.json`) and `schema_ref: "cedar://schema/cedar-sandbox"`.

**Response:**

```json
{
  "valid": true,
  "entity_count": 11,
  "errors": []
}
```

When some entities fail validation, `valid` flips to `false` and `errors` lists per-entity findings:

```json
{
  "valid": false,
  "entity_count": 1,
  "errors": [
    {
      "entity_uid": "MyApp::User::\"alice\"",
      "error_kind": "type_mismatch",
      "attribute": "name",
      "message": "entity does not conform to the schema: in attribute `name` on `MyApp::User::\"alice\"`, type mismatch: value was expected to have type string, but it actually has type long: `42`"
    }
  ]
}
```

`error_kind` is one of: `unknown_type`, `missing_required_attribute`, `type_mismatch`, `unknown_attribute`, `disallowed_parent_type`, `parse_error`, `other`. The `attribute` field is present for attribute-related errors. `disallowed_parent_type` fires when an entity's `parents` array contains a type the schema doesn't allow as an ancestor for that entity type.

**When to use:**
- when working with entity dumps from AVP `BatchGet` or custom entity stores
- before running `cedar_authorize` on a request that includes user-supplied entities, to catch shape issues early
- inside a CI pipeline that publishes an entity snapshot, to fail fast on drift

---
