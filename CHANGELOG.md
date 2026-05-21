# Changelog

All notable changes to `cedar-mcp-server` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). This project uses [SemVer](https://semver.org/) from v1.0.0 onward. The `0.x` line is pre-release; breaking changes can happen between `0.x` releases.

---

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/Pigius/cedar-mcp-server/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/Pigius/cedar-mcp-server/releases/tag/v0.0.1

---

## Release process

To release: bump version in `package.json`, commit, `git tag v0.X.Y`, `git push --tags`. The release workflow runs build + tests + `npm publish` with provenance. Requires `NPM_TOKEN` repo secret pre-configured.
