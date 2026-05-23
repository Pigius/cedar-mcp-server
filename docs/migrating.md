# Migrating from Amazon Verified Permissions or the Cedar CLI

If you are already running Cedar via AVP or `cedar-cli`, the sections below cover the differences and what cedar-mcp-server adds on top.

## From Amazon Verified Permissions

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


## From cedar-cli or cedar-policy-cli

The Cedar project ships a CLI (`cedar`) for one-shot policy operations. This MCP server is complementary, not a replacement.

| Operation | cedar CLI | cedar-mcp-server |
|-----------|-----------|------------------|
| Validate a policy file | `cedar validate` | `cedar_validate` |
| Evaluate a request | `cedar authorize` | `cedar_authorize` |
| Format a policy file | `cedar format` | `cedar_format` |
| Translate policy to JSON | `cedar translate` | `cedar_translate` |
| Explain a policy | (none) | `cedar_explain` |
| Check if a change needs delete-recreate | (none) | `cedar_check_policy_change` |
| Generate a test request payload | (none) | `cedar_generate_sample_request` |
| Plan a policy change from intent | (none) | `cedar_advise` |
| Diff two policy stores with AVP classification | (none) | `cedar_diff_policy_stores` |
| Validate a template policy | (none) | `cedar_validate_template` |
| Instantiate a template (bind slots) | (none) | `cedar_link_template` |
| List templates / links in a store | (none) | `cedar_list_templates`, `cedar_list_template_links` |

**When to use the CLI:** one-shot scripts, CI pipelines, or shell automation.

**When to use this server:** conversational workflows where you want Cedar reasoning inside the same context as your question, workspace-aware operations (reading live policy files from disk via roots), or the planning and diffing tools that have no CLI equivalent.

A practical pattern: use `avp-cli` to pull policy stores from AVP to disk, then use this server's roots support to read them for diffing and planning.
