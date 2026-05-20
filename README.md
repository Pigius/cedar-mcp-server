# cedar-mcp-server

MCP server for Cedar policy language. Validate, authorize, format, and translate Cedar policies directly inside Claude Code, Cursor, or any MCP-compatible AI assistant.

Built on the official [`@cedar-policy/cedar-wasm`](https://www.npmjs.com/package/@cedar-policy/cedar-wasm) bindings. No Docker. No AWS credentials. No Rust toolchain.

---

## What you get

Connect this server and your AI assistant can work with Cedar policies without leaving the conversation:

```
You:  Is this policy valid against my schema?
AI:   [calls cedar_validate] → "Line 3: attribute `owner` not found on entity
      type `Document`. Available attributes: classification, title."

You:  Would alice be allowed to read this document?
AI:   [calls cedar_authorize] → Decision: Allow. Determined by policy0.

You:  Format this policy file.
AI:   [calls cedar_format] → canonical Cedar style, returned inline.

You:  Give me the JSON representation of this policy.
AI:   [calls cedar_translate] → structured JSON, ready for programmatic use.
```

---

## Install

### Claude Code

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

### Cursor

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

First run pulls the package via `npx`. Subsequent runs use the npm cache.

---

## Tools

### `cedar_validate`

Validates Cedar policies against a schema. Returns errors with hints, source locations, and the policy count.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `policies` | yes | Cedar policy text (one or more policies) |
| `schema` | yes | Cedar schema (JSON object or `.cedarschema` text) |

**Valid policy:**

```
cedar_validate(
  policies: 'permit(principal in DocMgmt::Role::"admin", action, resource);',
  schema: '{ "DocMgmt": { ... } }'
)
```

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

---

### `cedar_authorize`

Evaluates an authorization request locally against your policies and entities. Returns the decision and which policies fired.

**Inputs:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `policies` | yes | Cedar policy text |
| `principal` | yes | Entity reference, e.g. `DocMgmt::User::"alice"` |
| `action` | yes | Entity reference, e.g. `DocMgmt::Action::"read"` |
| `resource` | yes | Entity reference, e.g. `DocMgmt::Document::"doc-001"` |
| `entities` | yes | JSON array of entity objects (uid, attrs, parents) |
| `schema` | no | Cedar schema (JSON or .cedarschema); enables request validation |
| `context` | no | JSON object with context attributes |

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

`determining_policies` lists the policy IDs that contributed to the decision. On a deny caused by a `forbid` policy, that policy's ID appears here.

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

The JSON policy format is Cedar's stable structured representation, useful for programmatic policy inspection, diffing, or generating policies from code.

---

## Workflow example

Here's a realistic session: a developer adding a new permission to an existing policy set.

**Step 1: write and validate**

```
You: I need a policy that lets editors read and write documents, but not delete.
     Here's my schema: [paste schema]

AI:  [calls cedar_validate with this policy + schema]

     permit (
       principal in DocMgmt::Role::"editor",
       action in [DocMgmt::Action::"read", DocMgmt::Action::"write"],
       resource
     );

     Valid. No errors.
```

**Step 2: verify the decision**

```
You: Would bob (editor) be allowed to delete doc-001?

AI:  [calls cedar_authorize]
     principal: DocMgmt::User::"bob"
     action:    DocMgmt::Action::"delete"
     resource:  DocMgmt::Document::"doc-001"

     Decision: Deny. No policy matched.
```

**Step 3: format before committing**

```
You: Format the full policy file.

AI:  [calls cedar_format]
     Returns canonical Cedar style, ready to commit.
```

---

## Cedar quick reference

A few things that trip up developers coming from IAM or OPA:

**Entity references use double colons and quoted IDs:**
```cedar
DocMgmt::User::"alice"      // correct
DocMgmt::User::alice        // wrong id must be quoted
```

**Array containment goes array-first:**
```cedar
["read", "write"].contains(action.name)   // correct
action.name in ["read", "write"]          // wrong Cedar doesn't support this form
```

**Optional attribute access needs a guard:**
```cedar
// Safe: checks existence before accessing
resource has tag && resource.tag == "confidential"

// Unsafe: if `tag` is optional, this silently makes the policy inapplicable
resource.tag == "confidential"
```

**`forbid` overrides `permit`:**
A single `forbid` policy matching a request blocks the decision regardless of how many `permit` policies also match.

---

## Contributing

The project uses TypeScript with `@modelcontextprotocol/sdk` and `@cedar-policy/cedar-wasm`.

```bash
git clone https://github.com/Pigius/cedar-mcp-server.git
cd cedar-mcp-server
npm install
npm test
```

Each tool lives in `src/tools/`. Tests live in `test/tools/`. The pattern is: one handler function per file, tested independently of the MCP server wiring.

---

## License

Apache 2.0, same as Cedar itself.
