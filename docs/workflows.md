# Workflows

Two angles: why route Cedar through this server when the assistant could just read your `.cedar` files, and the three-step PLAN / DIFF / APPLY workflow the tool surface is designed for.

## Why route through `cedar-mcp-server` instead of reading the files directly?

A fair question in an MCP client (Claude Code, Cursor) where the assistant can already Read the policy files in your workspace. If an LLM can read `policies/admin.cedar` and `schema.cedarschema`, why route through tool calls at all?

Because the tools encode things that do not live in the files.

#### Validation

`cedar_validate` and `cedar_validate_schema` run the official Cedar 4.11.0 parser. Reading a policy tells you what the author wrote, not whether the parser accepts it. Syntax errors, schema-type mismatches, missing-attribute references, optional-attribute access without a guard, and `appliesTo` violations all surface from the parser, not from text inspection. The parser is the only authority on validity.

#### Evaluation

`cedar_authorize` and `cedar_authorize_batch` run the Cedar engine. Reading a policy set tells you the rules; running them tells you the decisions. The default-deny behavior, forbid-overrides-permit precedence, optional-attribute silent-skip, action-group membership resolution, schema-validated entity typing, and condition short-circuiting are engine semantics. You cannot simulate the engine accurately by mental execution over the policy text, especially when the entity graph has parents or shared attributes.

#### Planning

`cedar_advise` returns a structured context bundle for any "I want to change my policies to do X" intent: schema summary, policy inventory with AST-classified Cedar pattern per file (Membership / Relationship / Discretionary / hybrid), intent-selected gotcha catalog (10 entries drawn from Cedar/AVP failure modes), AVP `UpdatePolicy` mutability rules, Cedar patterns reference, sequencing guidance, and explicit follow-up instructions. None of this lives in the policy files. AST-based pattern classification requires parsing each policy and walking the JSON; the AVP API contract requires knowing the `UpdatePolicy` spec; the gotcha catalog requires Cedar/AVP experience. The bundle is deterministic (no LLM round-trip on the server side); the calling assistant produces the actual plan from it and then verifies snippets via `cedar_validate` and `cedar_check_policy_change`.

#### Change safety

`cedar_check_policy_change`, `cedar_diff_schema`, and `cedar_diff_policy_stores` encode the AVP `UpdatePolicy` contract and the rules of which schema changes break which policies. Visually diffing two policies in a code review tells you what text changed; only these tools tell you whether AVP will accept the update in place, whether the change will silently drop existing policy matches, or whether decisions will flip for canonical requests. A text diff over schemas does not tell you which attribute removals break which policy reads.

#### Analysis

`cedar_explain` returns structure derived from the parsed AST: effect, scope breakdown, conditions, and detected patterns. Reading the policy gives the assistant a paraphrase; the AST gives ground truth (correct slot detection in templates, optional-attribute guard recognition, path-matching pattern detection, name-based identity recognition). For inherited policies that mix RBAC scope with ABAC conditions, the AST-derived breakdown is materially more reliable than text inspection.

#### Discoverability and sequencing

`cedar_list_templates`, `cedar_list_template_links`, the `cedar://policies/{store}` and `cedar://entities/{store}` resource URIs, and the StoreManager-backed `policy_ref` / `schema_ref` / `entities_ref` parameters give the assistant a stable, schema-aware view of the project. Doing this through `ls` and `cat` works for one-off inspection, but the tools encode the store layout convention (`policies/`, `entities/`, `templates/`, `template-links/`, `schema.cedarschema` or `schema.json`) and surface only what the other tools will actually resolve.

Rule of thumb for assistants: if a question is "what does this policy look like?", Read is fine. If it is "is this valid?", "would it allow X?", "can I update it in place?", "what changes if I deploy this?", "what's the safest way to add Y?", or "what patterns does this store use?", the right answer is a tool call. The tools are load-bearing for correctness, not a convenience layer.

---

## The PLAN / DIFF / APPLY workflow

This server is designed around three steps in any Cedar policy lifecycle.

### 1. PLAN: from intent to a step-by-step Cedar policy change plan

Use `cedar_advise` to translate a natural-language description of what you want into a concrete, ordered list of Cedar and schema changes, with AVP deployment classification for each step.

```
You: I need to add a "contractor" role that can read documents
     but only if the document is marked as "external_share".
     Here's my current policy store: [attach via cedar:// ref or paste]

AI:  [calls cedar_advise]

     Step 1: Schema (no changes needed; "classification" attribute already exists).
     Step 2: Policy (new_policy_via_create_policy):
       permit (
         principal in MyApp::Role::"contractor",
         action == MyApp::Action::"read",
         resource
       )
       when { resource.classification == "external_share" };
     Gotcha (high): accessing resource.classification without a guard works here
     because the attribute is required in the schema. If you make it optional
     later, add `resource has classification &&` before the check.
```

### 2. DIFF: from "what changed" to "is it safe to deploy"

Configure two policy stores as MCP roots (production and staging), then use `cedar_diff_policy_stores` to get a structural diff plus AVP immutability classification for each change.

```
You: Compare staging and production policies before I promote.

AI:  [calls cedar_diff_policy_stores with blue: "production", green: "staging"]

     Added: contractor-read-external.cedar (new_policy_via_create_policy, safe to add)
     Modified: editor-policy.cedar (principal clause changed, requires_delete_recreate)
     Schema: unchanged

     Behavioral diff (optional): pass a list of authorization requests to see
     which decisions would change between the two stores.
```

### 3. APPLY: deploy with confidence

The server doesn't call AVP APIs directly. Apply your changes through your own deployment pipeline. The `avp_update_mode` classification from steps 1 and 2 tells you exactly which AVP operations each change requires:

- `new_policy_via_create_policy`: safe to add with `CreatePolicy`.
- `in_place_via_update_policy`: change action or conditions with `UpdatePolicy`.
- `requires_delete_recreate`: principal, resource, or effect changed; use `DeletePolicy` then `CreatePolicy`.

See [`avp-cli`](https://github.com/Pigius/avp-cli) for a companion CLI that handles the pull/push side.
