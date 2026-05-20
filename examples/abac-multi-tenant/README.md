# ABAC Multi-Tenant (SaaS document collaboration)

Attribute-based access control for a multi-tenant SaaS app where decisions depend on document visibility, ownership, and user plan tier.

## What this example covers

Four Cedar patterns that appear together in almost every real SaaS authorization model:

- **Name-based identity**: `principal.name == resource.owner_id` — matching a user to their own resources
- **Array containment**: `["internal", "public"].contains(resource.visibility)` — allowlist of values
- **Plan-tier gating**: `principal.plan == "pro" || principal.plan == "enterprise"` — feature flagging in Cedar
- **`forbid` with `unless`**: blocks private document access except for the owner

Demonstrates all five tools, with `cedar_check_policy_change` showing the principal-change trap.

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
npx tsx examples/abac-multi-tenant/run.ts
```

## Files

```
schema.json                    SaaS namespace: User (name, plan), Document (visibility, owner_id)
policies/
  owner-full-access.cedar      Owners have full access to their documents
  member-read-internal.cedar   Authenticated users can read internal/public docs
  premium-share-guard.cedar    Only pro/enterprise plan can share
  private-doc-guard.cedar      Private docs blocked for non-owners (forbid + unless)
entities/
  users-and-docs.json          Alice (enterprise), Bob (pro), Charlie (free) + documents
```

---

## Tool examples — copy and paste to Claude Code

### cedar_authorize

```
Is charlie allowed to read the salary-review document?

Policies: [paste all .cedar files]
Principal: SaaS::User::"charlie"
Action: SaaS::Action::"READ"
Resource: SaaS::Document::"salary-review"
Entities: [paste entities/users-and-docs.json]
Schema: [paste schema.json]
```

Expected: **Deny** — `salary-review` has `visibility: "private"` and `owner_id: "alice"`. Charlie is not the owner, so the `private-doc-guard` forbid fires.

```
Can charlie share the public-changelog?
```

Expected: **Deny** — `premium-share-guard` requires `plan == "pro"` or `"enterprise"`. Charlie is on the free plan.

### cedar_explain

```
Explain this Cedar policy:

permit (
  principal,
  action == SaaS::Action::"READ",
  resource
)
when {
  ["internal", "public"].contains(resource.visibility)
};
```

Expected: plain-English breakdown including the `contains()` containment check and the pattern detection `attribute_containment_check`.

### cedar_generate_sample_request

```
Generate a sample request that would be ALLOWED by this policy:

permit (
  principal,
  action == SaaS::Action::"SHARE",
  resource
)
when {
  principal.plan == "pro" || principal.plan == "enterprise"
};

Schema: [paste schema.json]
```

Expected: a principal with `plan: "pro"` or `"enterprise"`, with an explanation of which condition was satisfied.

### cedar_check_policy_change

```
Can this change be applied in-place in Amazon Verified Permissions?

Old policy:
permit(principal, action, resource) when { principal.name == resource.owner_id };

New policy:
permit(principal in SaaS::Role::"editor", action, resource);
```

Expected: **cannot update in-place** — switching from a condition-based identity check to a role-based principal scope changes the principal clause, which AVP treats as immutable.

---

## Test cases

| Principal | Action | Resource | Expected | Reason |
|-----------|--------|----------|----------|--------|
| alice (owner) | READ | salary-review (private) | **Allow** | Owner exempt from private-doc-guard |
| alice (owner) | DELETE | q4-roadmap | **Allow** | Owner full access |
| bob (non-owner, pro) | READ | q4-roadmap (internal) | **Allow** | member-read-internal matches |
| bob (non-owner, pro) | READ | salary-review (private) | **Deny** | private-doc-guard forbid, bob is not owner |
| bob (pro) | SHARE | public-changelog | **Allow** | pro plan satisfies premium-share-guard |
| charlie (non-owner, free) | READ | public-changelog (public) | **Allow** | member-read-internal: "public" in allowlist |
| charlie (free) | SHARE | public-changelog | **Deny** | free plan fails premium-share-guard |
| charlie (non-owner, free) | READ | salary-review (private) | **Deny** | private-doc-guard forbid |

---

## Common pitfalls in this pattern

**`principal.name` is not authentication.** Cedar doesn't verify identity — it evaluates the entity attributes you provide. If you pass `attrs: { name: "alice" }`, Cedar trusts it. The security boundary is in how you build your entity store, not in the Cedar policy.

**Array containment goes array-first.** Cedar uses `["a", "b"].contains(value)` — the array is on the LEFT, the value is on the right. Writing `value.contains("a")` is a type error because strings don't have a `contains` method in Cedar.

**`forbid` + `unless` is not the same as two separate permits.** The `unless` clause in `private-doc-guard` means "forbid UNLESS owner". Without the `unless`, the forbid would block the owner too and no `permit` could override it. Never assume a `permit` can override a `forbid` — it cannot.

**Plan-tier changes need policy updates.** If a user upgrades from free to pro, their `plan` attribute in the entity store must be updated before Cedar reflects the change. Cedar has no concept of time — it evaluates the current entity state only.
