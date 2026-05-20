# RBAC Document Management

Role-based access control for a document system — the simplest Cedar pattern and the right place to start.

## What this example covers

Four roles (admin, editor, viewer, no-role), three actions (READ, WRITE, DELETE), and a `forbid` policy that blocks access to top-secret documents regardless of role. Demonstrates `cedar_authorize`, `cedar_validate`, `cedar_explain`, and `cedar_generate_sample_request`.

## Quick start

Configure the MCP server in Claude Code (`.claude/settings.json`):

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

Or run offline:

```bash
npx tsx examples/rbac-document-management/run.ts
```

## Files

```
schema.json                    Cedar schema — DocMgmt namespace
policies/
  admin.cedar                  Admins can do anything
  editor.cedar                 Editors can read and write
  viewer.cedar                 Viewers can only read
  top-secret-forbid.cedar      Forbid top_secret access (except admins)
entities/
  users-and-docs.json          Alice (admin), Bob (editor), Charlie (viewer), Dave (no role)
```

---

## Tool examples — copy and paste to Claude Code

### cedar_validate

```
Validate these Cedar policies against the schema.

Schema:
[paste contents of schema.json]

Policies:
[paste all .cedar files]
```

Expected: valid, 4 policies, no errors.

### cedar_authorize

```
Would Bob be allowed to read the document "acquisition-details"?

Policies: [paste all .cedar files]
Principal: DocMgmt::User::"bob"
Action: DocMgmt::Action::"READ"
Resource: DocMgmt::Document::"acquisition-details"
Entities: [paste entities/users-and-docs.json]
Schema: [paste schema.json]
```

Expected: **Deny** — the `top-secret-forbid` policy fires. Bob is an editor but that forbid overrides his permit.

```
Would Alice be allowed to read acquisition-details?
```

Expected: **Allow** — Alice is an admin. The `unless` clause in the forbid exempts admins.

### cedar_explain

```
Explain this Cedar policy in plain English:

forbid (
  principal,
  action,
  resource
)
when {
  resource.classification == "top_secret"
}
unless {
  principal in DocMgmt::Role::"admin"
};
```

Expected: a breakdown showing `forbid_policy`, `role_exemption`, the when/unless conditions in plain English.

### cedar_generate_sample_request

```
Generate a sample request that would be DENIED by this policy:

permit (
  principal in DocMgmt::Role::"viewer",
  action == DocMgmt::Action::"READ",
  resource
);

Schema: [paste schema.json]
```

Expected: a complete entity payload with principal outside the viewer role.

### cedar_check_policy_change

```
Can this policy change be applied in-place in AWS Verified Permissions?

Old policy:
permit (
  principal in DocMgmt::Role::"viewer",
  action == DocMgmt::Action::"READ",
  resource
);

New policy:
permit (
  principal in DocMgmt::Role::"senior_viewer",
  action == DocMgmt::Action::"READ",
  resource
);
```

Expected: **cannot update in-place** — the principal clause changed. AVP requires delete and recreate.

---

## Test cases

| Principal | Action | Resource | Expected | Reason |
|-----------|--------|----------|----------|--------|
| alice (admin) | READ | acquisition-details | **Allow** | Admin policy permits |
| alice (admin) | DELETE | acquisition-details | **Allow** | Admin exempt from top_secret forbid |
| bob (editor) | WRITE | roadmap-2026 | **Allow** | Editor can write |
| bob (editor) | DELETE | roadmap-2026 | **Deny** | Editor cannot delete |
| bob (editor) | READ | acquisition-details | **Deny** | top_secret forbid overrides editor permit |
| charlie (viewer) | READ | public-announcement | **Allow** | Viewer can read |
| charlie (viewer) | WRITE | public-announcement | **Deny** | Viewer cannot write |
| charlie (viewer) | READ | acquisition-details | **Deny** | top_secret forbid overrides viewer permit |
| dave (no role) | READ | public-announcement | **Deny** | Default deny — no matching permit |
| dave (no role) | READ | acquisition-details | **Deny** | Default deny + top_secret forbid |

---

## Common pitfalls in this pattern

**`forbid` overrides `permit` — always.** A single matching `forbid` blocks the request regardless of how many `permit` policies also match. If you add an admin `permit` and a top-secret `forbid`, the `unless { principal in Role::"admin" }` clause is what lets admins through — not some priority system.

**Default deny is not a policy.** Cedar denies by default when no `permit` matches. Dave gets denied not because of a `forbid` but because no policy grants him anything. These are different: a `forbid` appears in `diagnostics.reason`; a default deny leaves `determining_policies` empty.

**Role membership is transitive via `parents`.** `principal in DocMgmt::Role::"admin"` is true when the entity has `"admin"` anywhere in its parent chain — direct or inherited. If roles inherit from other roles, the `in` check follows the chain.

**Schema validation catches attribute typos silently at runtime.** If you access `resource.clasification` (one `s`) without schema validation, Cedar silently makes the policy inapplicable rather than erroring. Always validate against the schema during development.
