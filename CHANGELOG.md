# Changelog

All notable changes to `cedar-mcp-server` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). This project uses [SemVer](https://semver.org/) from v1.0.0 onward. The `0.x` line is pre-release; breaking changes can happen between `0.x` releases.

---

## [Unreleased]

(No unreleased changes yet.)

---

## [1.0.0] — 2026-05-22

First published release. Twelve months of design + implementation + multi-round dogfood discipline now under SemVer. The 1.0.0 surface is 17 MCP tools, 8 MCP resource templates, 3 MCP prompts, plus a CLI entry that runs stdio (default) or Streamable HTTP.

### Added

#### `cedar_advise`: structured context bundle, not a sampling round-trip

- `cedar_advise` returns a deterministic context bundle (schema summary, AST-classified policy inventory, intent-selected gotcha catalog, AVP `UpdatePolicy` mutability rules, Cedar patterns reference, sequencing guidance, next-steps text). The calling assistant produces the plan from the bundle. No MCP sampling capability required; no client LLM round-trip on the server side.
- Auto-resolves to the single loaded store when `store_ref` is omitted (`auto_discovered.store_from: "single_loaded_store"`). With multiple stores loaded and no `store_ref`, returns `store_status: "ambiguous"` plus `available_stores` so the calling LLM can recover. Schemaless single-store cases degrade to `store_status: "not_provided"` rather than self-referential `not_found`.

#### Stable policy IDs in `determining_policies`

- Three-tier resolution: `@id("name")` annotation → file basename (when policies loaded via `cedar://policies/{store}` ref) → positional `policy<index>` fallback.
- Applied to both `cedar_authorize` and `cedar_authorize_batch`; the two return identical ID shapes for the same policy set.
- `cedar_authorize` also returns `decision_reason` with four explicit values: `permit_policy_fired`, `forbid_policy_fired`, `default_deny_no_permit_matched`, `evaluation_error`.

#### Parser feedback and source locations

- `cedar_validate` returns `line` and `column` (1-indexed) on every parse error, derived from the WASM source location and correctly accounting for multi-byte UTF-8 chars.
- A 17-entry typo table populates the `hint` field for common misspellings (`int`/`in`, `prinicpal`/`principal`, `permint`/`permit`, `wen`/`when`, etc.); falls back to Cedar's own diagnostic help when no entry matches; `null` otherwise.

#### Two-mode `cedar_validate`

- Syntax-only mode (no schema): runs the parser alone. Useful for typo / scope sanity checks.
- Syntax-and-schema mode (schema supplied or auto-discovered): adds attribute typing, action applicability, `UnsafeOptionalAttributeAccess` warnings.
- Explicit `validation_mode: "auto" | "syntax_only" | "syntax_and_schema"` parameter forces a specific mode (default `"auto"`).

#### Workspace auto-discovery for stdio

- When stdio launches in a directory that looks like a Cedar policy store (`schema.cedarschema`, `schema.json`, or a `policies/` subdirectory), the server loads the cwd **synchronously before the transport accepts client requests**. By the time the first `resources/list` arrives, the store is already populated.
- `cedar_validate`, `cedar_authorize`, `cedar_explain` consult the loaded store when their required inputs are omitted; the response's `auto_discovered.*_from` fields name which store satisfied each missing input.
- Multi-store deployments surface an `ambiguous` error listing candidate names; pass `store: "<name>"` to disambiguate.
- Security guard: refuses to load roots whose normalized path is empty (`file:///`), preventing the `isPathAllowed` `startsWith("")` bypass that would otherwise grant access to every filesystem path.

#### `cedar_authorize_batch`: decision matrix over a shared policy set

- Runs N authorization requests through one policy set in a single call. Returns total / allowed / denied / errored counts plus a per-request decision array with `determining_policies` (basenames, same H1 resolution as `cedar_authorize`). Schema-violating requests resolve to `decision: "Error"` when `schema + validateRequest` is in play.

#### Template operations

- `cedar_validate_template`: validates a Cedar policy template against a schema; supports cedarschema and JSON forms.
- `cedar_link_template`: links a template to a concrete principal and resource, producing a template-linked policy.
- `cedar_list_templates` / `cedar_list_template_links`: lists templates and links in a store; per-item read errors surface as structured errors rather than throwing.
- `StoreManager` extended with `listTemplates`, `readTemplate`, `listTemplateLinks`, `readTemplateLink`.
- New MCP Resources: `cedar://templates/{store}`, `cedar://templates/{store}/{id}`, `cedar://template-links/{store}`, `cedar://template-links/{store}/{id}`.

#### Schema and entity standalone operations

- `cedar_validate_schema`: standalone schema validation, JSON or cedarschema text. Returns validity flag, format, namespace list, entity/action/common-type counts, errors with source locations.
- `cedar_diff_schema`: structural schema diff with AVP-aware risk classification per change (`safe` / `review` / `breaking`) plus a top-level `risk_level`. Accepts inline schema text or `cedar://schema/{store}` URIs.
- `cedar_validate_entities`: validates an entity store against a schema; classifies errors by kind (`unknown_type`, `missing_required_attribute`, `type_mismatch`, `unknown_attribute`, `disallowed_parent_type`, `parse_error`, `other`).

#### `cedar_generate_sample_request`

- Generates a complete authorization request payload (principal, action, resource, entities) that produces a target Allow / Deny decision against a given policy and schema.
- Pre-fills required entity attributes from the schema (Cedar's `required: true` default for JSON-schema attributes).
- Verifies the generated payload against `cedar_authorize` with `validateRequest: true`; `ready_to_test: true` confirms a follow-up call with these exact inputs reproduces the documented decision. Schema-mismatched payloads return `ready_to_test: false` with an actionable error.
- Single-prefix entity refs (`MyApp::User::"alice"`) regardless of whether the schema was supplied as `.cedarschema` text or as JSON.

#### Streamable HTTP mode

- New transport for shared team deployment. CLI: `cedar-mcp-server --http <port> [--host <host>] [--root name=path]...`. Stdio remains the default.
- Per-session `McpServer` + transport pair with stateful `Mcp-Session-Id` routing.
- Shared `storeManager` across HTTP sessions; deployment model is "one server per policy-store set." Deployer-configured roots via repeatable `--root` flags.
- Security: localhost default-binding with DNS rebinding protection. Non-localhost binding (`--host 0.0.0.0`) is the deployer's responsibility (auth via reverse proxy).
- Max-sessions cap (default 100, configurable via `CEDAR_MAX_HTTP_SESSIONS`) returns HTTP 503 when reached.
- Idle-session TTL (default 30 min, configurable via `CEDAR_HTTP_SESSION_IDLE_TTL_MS`) with a periodic reaper.
- `/health` endpoint returns `{ status, transport, mode, active_sessions, max_sessions, session_idle_ttl_ms }`.

#### `cedar://` resources end-to-end

- Each `ResourceTemplate` carries a `list:` callback so MCP clients can enumerate via `resources/list` rather than guessing URIs. Eight resource templates registered.
- `notifications/resources/list_changed` emitted after every store reconciliation pass so cache-aware clients can refetch on root changes.
- `ref-resolver.ts` resolves `cedar://policies/{store}`, `cedar://schema/{store}`, `cedar://entities/{store}` (and per-id variants), `cedar://templates/{store}`, `cedar://template-links/{store}`.
- `cedar_authorize` / `cedar_authorize_batch` / `cedar_explain` / `cedar_validate` accept the matching `_ref` parameters.

#### MCP Prompts

- `cedar-review-policy-diff`: drives `cedar_diff_policy_stores` + `cedar_diff_schema`, summarizes risk, advises on promotion.
- `cedar-explain-denial`: runs `cedar_authorize` via `cedar://` refs + `cedar_explain` on the deciding policies; produces a plain-English explanation.
- `cedar-avp-migration-checklist`: guided checklist for AVP migration; optional `namespace` argument substitutes the placeholder.

#### Server instructions and discoverability

- `SERVER_INSTRUCTIONS` returned on `initialize`: a routing table that directs the MCP client to call `cedar_*` tools rather than `Read`/`Bash` on policy files, plus the workspace-auto-discovery directive. Truncated to fit under Claude Code's 2KB instructions budget.

### Changed (relative to the development 0.0.1 milestone)

- `cedar_advise`: replaced the sampling-based design with the deterministic context bundle described above. The old `previous_plan` delta-output API is gone with it; the calling assistant iterates the plan in conversation.
- `cedar_diff_policy_stores`: `schema_diff` field is now a structured `SchemaDiff` object (with per-change risk classification) replacing the previous `schema_changed: boolean` + `schema_diff_note: string` fields.

### Fixed (relative to the development 0.0.1 milestone)

- `cedar_validate`: line / column derivation correctly counts Unicode code points (not UTF-16 code units), so non-ASCII characters before the error site no longer drift the reported column.
- `cedar_validate_entities`: removed the incorrect `orphan_parent` error kind (no such Cedar concept); `disallowed_parent_type` now recognized rather than collapsing to `error_kind: "other"`.

---

## [0.0.1] — 2026-05-20

Development milestone. Internal-only; never published to npm. Documents the four implementation phases (cedar_validate / cedar_authorize / cedar_format / cedar_translate; cedar_explain / cedar_check_policy_change / cedar_generate_sample_request; MCP Roots and Resources; cedar_advise via MCP sampling). Detailed feature breakdown below for historical reference; v1.0.0 above is the canonical surface.

### Phase 4 — Planning: `cedar_advise`

- `cedar_advise`: translates natural-language intent into a step-by-step Cedar policy change plan via MCP sampling. Server builds deterministic context (schema, policy inventory with patterns and Cedar text, selected gotchas, AVP rules summary); LLM produces intent interpretation, applicable Cedar pattern, ordered change steps with Cedar snippets, AVP deployment classification, and verification steps.
- Iterative refinement via `previous_plan`: passing a previous result triggers delta output (unchanged/modified/added/removed steps).
- Supporting modules: `avp-rules.ts` (10 AVP validation error categories, UpdatePolicy mutability map), `cedar-patterns.ts` (AST-based policy classifier), `gotchas.ts` (10-entry gotcha catalog with keyword-based selection), `context-builder.ts` (walks policy store files for prompt context).
- `postProcess()` enforces deterministic corrections: `policy_new` always maps to `new_policy_via_create_policy`, `policy_delete` always maps to `requires_delete_recreate`, schema-before-policy ordering violations surface as a gotcha.

(This sampling-based design was replaced in v1.0.0 by the deterministic context bundle. See the v1.0.0 entry above.)

### Phase 3 — Roots, Resources, Diffing

- MCP Roots integration: loads policy stores on server init, reloads on `RootsListChangedNotification`.
- `StoreManager`: maps `file://` root URIs to named stores; reads `.cedar` policy files from `policies/` subdirectory; reads `schema.cedarschema` or `schema.json`. Security: validates policy IDs against `^[a-zA-Z0-9_-]+$` (no path traversal); rejects non-`file://` URIs.
- `cedar://` MCP Resources: `cedar://policies/{store}`, `cedar://policies/{store}/{id}`, `cedar://schema/{store}`.
- `policy_ref` and `schema_ref` parameters on `cedar_validate`, `cedar_authorize`, and `cedar_explain`: accept `cedar://` URIs as alternatives to inline text.
- `cedar_diff_policy_stores`: structural diff (added/removed/modified policies with AVP immutability classification per change), schema diff, optional behavioral diff (runs authorization requests through both stores and surfaces decision drift).

### Phase 2 — Planning and Understanding

- `cedar_explain`: explains a Cedar policy in plain English with pattern detection. Supports templates via `templateToJson` fallback.
- `cedar_check_policy_change`: determines whether a policy modification can be applied in-place in AVP or requires delete-and-recreate. Uses AST comparison against AVP UpdatePolicy immutability rules.
- `cedar_generate_sample_request`: generates a complete authorization request payload (principal, action, resource, entities) that produces a target decision against a given policy. Verifies the generated payload against `cedar_authorize`.

### Phase 1 — Validation and Evaluation

- `cedar_validate`: validates Cedar policies against a schema using `@cedar-policy/cedar-wasm`. Returns errors with hints and source locations.
- `cedar_authorize`: evaluates an authorization request locally. Auto-detects and converts all three AVP SDK entity formats (snake_case Ruby, camelCase Python/JS, PascalCase official API). Unwraps typed attribute wrappers and entity reference wrappers recursively.
- `cedar_format`: formats Cedar policy text to canonical style.
- `cedar_translate`: translates between Cedar text and JSON formats for policies and schemas.

### Original [Unreleased] block (pre-v1.0.0, kept for archaeological reference)

The features below were originally batched under `[Unreleased]` during the v0.x development line; all of them shipped as part of v1.0.0 above.

#### Template operations (Batch A)
- `cedar_validate_template`: validates a Cedar policy template (static template text) against a schema; supports both cedarschema and JSON schema formats.
- `cedar_link_template`: links a policy template to a concrete principal and resource, producing a template-linked policy in the store.
- `cedar_list_templates`: lists all policy templates in a store; per-item read errors surface as structured errors rather than throwing.
- `cedar_list_template_links`: lists all template-linked policies in a store; per-item read errors surface as structured errors rather than throwing.
- `StoreManager` extended with `listTemplates`, `readTemplate`, `listTemplateLinks`, and `readTemplateLink` methods.
- New MCP Resources: `cedar://templates/{store}`, `cedar://templates/{store}/{id}`, `cedar://template-links/{store}`, `cedar://template-links/{store}/{id}`.
- `SECURITY.md` added to the repository.

#### Schema and entity standalone operations (Batch B)
- `cedar_validate_schema`: standalone schema validation accepting JSON or cedarschema text; returns validity flag, detected format, namespace list, entity/action counts, and errors with source locations.
- `cedar_diff_schema`: structural schema diff with AVP-aware risk classification; each change is classified as `safe`, `review`, or `breaking` with a reason; accepts inline schema text or `cedar://schema/{store}` URIs.
- `cedar_validate_entities`: validates an entity store against a schema; classifies errors by kind (`unknown_type`, `missing_required_attribute`, `type_mismatch`, `unknown_attribute`, `disallowed_parent_type`, `parse_error`, `other`).

#### Batch authorization (Batch C)
- `cedar_authorize_batch`: runs N authorization requests through one policy set and returns the decision matrix (total/allowed/denied/errored counts plus per-request decision array with `determining_policies` from WASM `diagnostics.reason`). Schema-violating requests resolve to `decision: "Error"` when `schema + validateRequest` is in play; without schema, the same request is silently evaluated.

#### MCP Prompts (Batch D)
- `cedar-review-policy-diff`: drives `cedar_diff_policy_stores` + `cedar_diff_schema`, summarizes risk, advises on promotion.
- `cedar-explain-denial`: runs `cedar_authorize` via `cedar://` refs + `cedar_explain` on deciding policies; produces plain-English explanation.
- `cedar-avp-migration-checklist`: guided checklist for AVP migration; optional `namespace` arg substitutes `<YourNamespace>` placeholder when omitted.

#### Entities resource access (Batch E)
- `StoreManager` extended with `listEntities`, `readEntities`, and `readAllEntities` methods (entity files live in `entities/*.json` under the store root).
- New MCP Resources: `cedar://entities/{store}` (merged JSON across entity files) and `cedar://entities/{store}/{file_id}` (single file).
- `ref-resolver.ts` now also resolves `cedar://templates/{store}`, `cedar://templates/{store}/{id}`, `cedar://template-links/{store}`, and `cedar://template-links/{store}/{id}` — previously the corresponding MCP Resources were registered but the URIs were not resolvable as `*_ref` parameters in tools.
- `cedar_authorize` and `cedar_authorize_batch` gained an `entities_ref` parameter; either inline `entities` or `entities_ref` is now accepted.

#### HTTP transport (Batch F)
- New Streamable HTTP transport for shared team deployment. CLI: `cedar-mcp-server --http <port> [--host <host>] [--root name=path]...`. Stdio remains the default.
- Per-session McpServer + transport pair with stateful `Mcp-Session-Id` routing (Streamable HTTP spec requires per-session protocol state).
- Shared `storeManager` across HTTP sessions — deployment model is "one server per policy-store set." Deployer-configured roots via repeatable `--root` flags; client `listRoots()` is not called in HTTP mode.
- Security: localhost default-binding with DNS rebinding protection via the SDK's `createMcpExpressApp`. Non-localhost binding is the deployer's responsibility (auth via reverse proxy).
- Max-sessions cap (default 100) returns HTTP 503 when reached; backpressure rather than eviction. Configurable via `maxSessions` option or `CEDAR_MAX_HTTP_SESSIONS` env var.
- Idle-session TTL (default 30 min) with a periodic reaper that evicts sessions whose last request exceeds the TTL. Catches the case where `transport.onclose` doesn't fire (network partition, TCP RST). Configurable via `sessionIdleTtlMs` option or `CEDAR_HTTP_SESSION_IDLE_TTL_MS` env var.
- New `/health` endpoint returns `{ status, transport, mode, active_sessions, max_sessions, session_idle_ttl_ms }`.
- New deps: `express`, `@types/express`.
- Integration smoke tests covering listTools/cedar_validate/cedar_authorize over real HTTP transport, the /health endpoint, malformed JSON body falsification, multiple concurrent sessions via independent Mcp-Session-Id, the deployer-configured `--root` path (cedar:// URI resolution end-to-end), max-sessions cap returning 503, and idle TTL eviction by the reaper.

### Changed
- `cedar_diff_policy_stores`: `schema_diff` field is now a structured `SchemaDiff` object (with per-change risk classification) replacing the previous `schema_changed: boolean` + `schema_diff_note: string` fields.

### Fixed
- `cedar_validate_entities`: removed incorrect `orphan_parent` error kind (no such Cedar concept); added `disallowed_parent_type` recognition that previously fell through to `error_kind: "other"`.

---

## [0.0.1] — 2026-05-20

First tagged release. All four implementation phases shipped.

### Phase 4 — Planning: `cedar_advise`

- `cedar_advise`: translates natural-language intent into a step-by-step Cedar policy change plan via MCP sampling. Server builds deterministic context (schema, policy inventory with patterns and Cedar text, selected gotchas, AVP rules summary); LLM produces intent interpretation, applicable Cedar pattern, ordered change steps with Cedar snippets, AVP deployment classification, and verification steps.
- Iterative refinement via `previous_plan`: passing a previous result triggers delta output (unchanged/modified/added/removed steps).
- Supporting modules: `avp-rules.ts` (10 AVP validation error categories, UpdatePolicy mutability map), `cedar-patterns.ts` (AST-based policy classifier), `gotchas.ts` (10-entry gotcha catalog with keyword-based selection), `context-builder.ts` (walks policy store files for prompt context).
- `postProcess()` enforces deterministic corrections: `policy_new` always maps to `new_policy_via_create_policy`, `policy_delete` always maps to `requires_delete_recreate`, schema-before-policy ordering violations surface as a gotcha.

### Phase 3 — Roots, Resources, Diffing

- MCP Roots integration: loads policy stores on server init, reloads on `RootsListChangedNotification`.
- `StoreManager`: maps `file://` root URIs to named stores; reads `.cedar` policy files from `policies/` subdirectory; reads `schema.cedarschema` or `schema.json`. Security: validates policy IDs against `^[a-zA-Z0-9_-]+$` (no path traversal); rejects non-`file://` URIs.
- `cedar://` MCP Resources: `cedar://policies/{store}`, `cedar://policies/{store}/{id}`, `cedar://schema/{store}`.
- `policy_ref` and `schema_ref` parameters on `cedar_validate`, `cedar_authorize`, and `cedar_explain`: accept `cedar://` URIs as alternatives to inline text.
- `cedar_diff_policy_stores`: structural diff (added/removed/modified policies with AVP immutability classification per change), schema diff, optional behavioral diff (runs authorization requests through both stores and surfaces decision drift).

### Phase 2 — Planning and Understanding

- `cedar_explain`: explains a Cedar policy in plain English with pattern detection. Supports templates via `templateToJson` fallback.
- `cedar_check_policy_change`: determines whether a policy modification can be applied in-place in AVP or requires delete-and-recreate. Uses AST comparison against AVP UpdatePolicy immutability rules.
- `cedar_generate_sample_request`: generates a complete authorization request payload (principal, action, resource, entities) that produces a target decision against a given policy. Verifies the generated payload against `cedar_authorize`.

### Phase 1 — Validation and Evaluation

- `cedar_validate`: validates Cedar policies against a schema using `@cedar-policy/cedar-wasm`. Returns errors with hints and source locations.
- `cedar_authorize`: evaluates an authorization request locally. Auto-detects and converts all three AVP SDK entity formats (snake_case Ruby, camelCase Python/JS, PascalCase official API). Unwraps typed attribute wrappers and entity reference wrappers recursively.
- `cedar_format`: formats Cedar policy text to canonical style.
- `cedar_translate`: translates between Cedar text and JSON formats for policies and schemas.

---

[Unreleased]: https://github.com/Pigius/cedar-mcp-server/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Pigius/cedar-mcp-server/releases/tag/v1.0.0
[0.0.1]: https://github.com/Pigius/cedar-mcp-server/releases/tag/v0.0.1

---

## Release process

To release: bump version in `package.json`, commit, `git tag v0.X.Y`, `git push --tags`. The release workflow runs build + tests + `npm publish` with provenance. Requires `NPM_TOKEN` repo secret pre-configured.
