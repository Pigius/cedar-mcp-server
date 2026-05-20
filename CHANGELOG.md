# Changelog

All notable changes to `cedar-mcp-server` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). This project uses [SemVer](https://semver.org/) from v1.0.0 onward. The `0.x` line is pre-release; breaking changes can happen between `0.x` releases.

---

## [Unreleased]

### Added
- Snippet validation in `cedar_advise`: LLM-generated Cedar snippets are now validated via `policyToJson` before return. Snippets that fail to parse are surfaced as high-severity gotchas (`invalid_cedar_snippet_in_plan`) rather than passed through silently.
- Integration smoke test: end-to-end test spawning the server via stdio and exercising `cedar_validate` and `cedar_authorize` through a real MCP client transport.
- Full README rewrite: hero pitch, PLAN/DIFF/APPLY workflow narrative, all 9 tool detail sections, MCP Roots setup guide, Coming from AVP/cedar-cli/fresh-to-Cedar sections, troubleshooting, compatibility table, versioning policy.
- `CONTRIBUTING.md` and `CHANGELOG.md`.

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
