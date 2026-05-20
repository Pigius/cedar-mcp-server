# Security

## Trust boundary

`cedar-mcp-server` is a local MCP server. It runs as a child process on the same machine as the MCP client (Claude Code, Claude Desktop, Cursor, etc.). The trust model is: the client and its workspace are trusted. The server does not authenticate callers, enforce rate limits, or apply any network-level access controls.

Do not expose this server over a network without an authentication layer in front of it. The stdio transport (`npx cedar-mcp-server`) is local-only by design.

## What the server does

- Evaluates Cedar policies and authorization requests in-process using `@cedar-policy/cedar-wasm`. No network calls.
- Reads `.cedar` and `.cedarschema` / `.json` files from directories configured as MCP Roots. Reads only; never writes to the filesystem.
- Calls the MCP client's `sampling/createMessage` capability for `cedar_advise`. The client decides whether to fulfill the sampling request and which model to use.

## What the server does NOT do

- Makes no calls to AWS APIs or Amazon Verified Permissions.
- Makes no outbound network requests of any kind.
- Does not write, modify, or delete files on disk.
- Does not execute arbitrary code from policy inputs.
- Does not store policy text, entity data, or authorization results anywhere outside the MCP conversation.

## Input validation

**Policy IDs.** Policy files are loaded from the `policies/` subdirectory of each configured root. Policy IDs are derived from filenames and validated against `^[a-zA-Z0-9_-]+$` before use. IDs containing path separators or `..` sequences are rejected. This prevents directory traversal attacks on the policy store.

**Root URIs.** Only `file://` URIs are accepted as MCP Roots. Non-`file://` URIs (e.g. `http://`) are rejected at load time.

**Policy and schema text.** Cedar policies and schemas passed as inline text or read from disk are evaluated inside the `@cedar-policy/cedar-wasm` WASM sandbox. They cannot execute arbitrary code. Malformed input returns a structured error, not a process crash.

**Entity JSON.** Entity data is parsed and passed to the Cedar evaluator. It is not executed. Excessively large entity payloads may cause slow evaluation but do not create a code execution path.

## Reporting a vulnerability

If you find a security issue in this project, open a [GitHub Issue](https://github.com/Pigius/cedar-mcp-server/issues) with the label `security`. For issues you prefer not to disclose publicly, email the maintainer directly (contact via the GitHub profile).

Please include: a description of the issue, steps to reproduce, and the potential impact.
