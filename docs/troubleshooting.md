# Troubleshooting and known limitations

## Troubleshooting

**"schema not found in store"**

The server looked for `schema.cedarschema` or `schema.json` in the root directory but found neither. Check that your policy store directory has one of these files at the root level, not inside the `policies/` subdirectory.

**"store X not found, no roots configured"**

You passed a `cedar://` reference or a store name to a tool, but no MCP roots are configured. Add a `roots` entry to your MCP client config (see [Getting started](./getting-started.md#configure-policy-stores-mcp-roots)).

**"policy_text and policy_ref both provided"**

Inline text takes precedence, but passing both is probably a mistake. Remove one.

**"Failed to initialize Cedar WASM"**

The `@cedar-policy/cedar-wasm` module failed to load. This typically means the npm package is corrupted or the Node.js version is too old. Run `node --version` and verify it's 20 or higher. Delete `node_modules` and reinstall if the version is correct.

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

Other MCP clients that support the MCP 1.0 protocol should work with every tool. All 17 tools are deterministic; none of them require the MCP `sampling/createMessage` capability. `cedar_advise` is also deterministic in the current design (kickoff-08 pivoted it from a sampling-based planner to a structured context bundle, so the calling assistant produces the actual plan from the bundle).

---

## Known limitations

This server runs Cedar 4.11.0 through `@cedar-policy/cedar-wasm`. That WASM package does not expose Cedar's symbolic-analysis backend (`cedar-policy-symcc`), so the following capabilities are NOT available in this server:

- **Semantic equivalence between two policy sets.** "Do these two policy sets produce the same decision for every well-formed request?" `cedar_diff_policy_stores` performs a structural diff plus an optional behavioral diff over a request matrix you supply, but neither proves logical equivalence.
- **Full shadowing detection.** `cedar_diff_policy_stores` and Cedar's own `validate` surface some shadowing cases, but a complete pairwise shadowing analysis (does policy A's match condition imply policy B's?) requires SMT.
- **Full reachability / dead-policy analysis.** Cedar's WASM `validate` surfaces dead policies that fail trivially (schema-mismatched scopes, literal-folding unsat such as `when { 1 == 2 }`, type-incompatible expressions). It does not catch attribute-value contradictions like `when { age > 18 && age < 10 }`.
- **`never-errors` verification.** Proving that a policy can never produce a runtime error.

Cedar's official CLI ships these as 11 verification subcommands under `cedar symcc`, but only when built with `cargo install cedar-policy-cli --features analyze` and used together with the CVC5 SMT solver. That install chain is incompatible with the `npx`-only positioning of this server, so the SMT tools are not bundled today.

**Future direction:** if upstream Cedar exposes `cedar-policy-symcc` through `@cedar-policy/cedar-wasm`, the equivalent tools land here directly. Otherwise a companion package (e.g. `cedar-mcp-server-analyze`) that shells out to a locally-installed `cedar symcc` is the most likely path. No timeline.

### Multi-store under stdio

Stdio mode loads at most one synchronous cwd-fallback store (named after the cwd's basename) plus any roots the MCP client advertises via `listRoots()`. Claude Code does not currently advertise the workspace as a root, so in practice stdio is single-store: the cwd. To work with multiple Cedar policy stores from one client session, two options:

1. Run the server in HTTP mode with one `--root name=path` flag per store, and point your client at the HTTP endpoint. All connected clients see the same multi-store set.
2. Register the same `cedar-mcp-server` binary multiple times in your client's MCP configuration, each with its own working directory (or each pointing at a different cwd via the client's per-server config). Each instance becomes a separate MCP server with its own single store.

The pure-stdio multi-store-from-cwd model (one process, multiple stores discovered without `--root` or `listRoots()`) is not supported. Tracked for v1.1.
