# Contributing

Contributions are welcome. This document covers how to set up locally, the conventions used in this project, and what's expected in a pull request.

---

## Local setup

```bash
git clone https://github.com/Pigius/cedar-mcp-server.git
cd cedar-mcp-server
npm install
npm test
```

Requires Node.js 20 or higher.

---

## Project structure

```
src/
  index.ts            MCP server entry point, roots loading
  server.ts           Tool registration and request routing
  tools/              One handler file per tool
  tools/advise/       Supporting modules for cedar_advise
  resources/          StoreManager, ref-resolver
  parser/             Cedar AST utilities
  utils/              Format detection, shared helpers
test/
  tools/              Unit tests for each tool handler
  resources/          Unit tests for StoreManager and ref-resolver
  integration/        End-to-end smoke tests
  fixtures/           Shared test fixtures
```

Each tool lives in `src/tools/<name>.ts` with a corresponding test in `test/tools/<name>.test.ts`. The pattern is one exported handler function per file, tested independently of the MCP server wiring.

---

## Running tests

```bash
npm test                          # all unit tests
npx vitest run test/integration   # integration smoke tests (spawns the server)
```

Unit tests are fast and self-contained. Integration tests spawn the server as a child process and require a built or runnable server; they run separately from the unit suite.

---

## Test data and NDA discipline

Test fixtures in `test/fixtures/` use only the abstract datasets from this repository (DocMgmt, Gateway, generic SaaS namespaces). Do not add fixtures derived from real client systems. The same rule applies to examples in `examples/`: generic, abstract, no real company or product names.

---

## Conventions

**TDD cadence.** For new tools and bug fixes, write a failing test first, then implement. Commits should reflect this: a red test commit, then a green implementation commit.

**Post-phase audit.** Before any release tag or `npm publish`, run the post-phase audit checklist: verify claims in README match code, check for dead links, confirm version numbers are consistent across `package.json`, `CHANGELOG.md`, and README compatibility table.

**No silent breaking changes.** If a tool's input or output shape changes in a way that breaks existing callers, that's a major version bump. Document it in `CHANGELOG.md` under the new version.

**No new dependencies without a reason.** The WASM approach keeps the install footprint minimal. New runtime dependencies need justification.

---

## Pull request expectations

- Tests pass: `npm test` green.
- Type check clean: `npx tsc --noEmit` passes.
- `CHANGELOG.md` updated under `[Unreleased]` with a description of what changed.
- If you're adding a new tool, add it to the tools table and tool details section in `README.md`.
- If you're changing a tool's input or output schema, update the relevant section in `README.md`.

---

## Issues

Bug reports and feature requests via GitHub Issues. For bugs, include the tool name, the input that triggered the issue, and the actual vs expected output.
