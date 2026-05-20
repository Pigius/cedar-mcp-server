# API Gateway Path Routing

Role-based access control for a REST API gateway — combining role membership, HTTP method restriction, path matching, and depth limiting in a single Cedar policy.

## What this example covers

Three policies that mirror a real API gateway authorization model:

- **Role-based action restriction**: `action in [API::Action::"GET", API::Action::"POST"]` — developers can read and create, but not update or delete
- **Exact path match**: `resource.path == "/api/v1/projects"` — collection endpoint
- **Path matching with depth limiting**: `like "/api/v1/projects/*" && !(like "/api/v1/projects/*/*")` — allows one path segment deep, blocks sub-resources
- **No depth limit for viewers**: viewers can GET at any depth, developers cannot POST beyond one level

The `cedar_generate_sample_request` results show the depth-limiting in action: the allow path is `/api/v1/projects/x`, the deny path is `/api/v1/projects/x/x`.

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
npx tsx examples/api-gateway-path-routing/run.ts
```

## Files

```
schema.json                         API namespace: User, Role, Endpoint (path, method)
policies/
  admin-full-access.cedar           Admins: any action, any endpoint
  developer-projects.cedar          Developers: GET/POST, depth-limited to one level
  viewer-readonly.cedar             Viewers: GET only, any depth
entities/
  users-and-roles.json              Alice (admin), Bob (developer), Charlie (viewer)
```

---

## Tool examples — copy and paste to Claude Code

### cedar_authorize

```
Would Bob be allowed to GET /api/v1/projects/proj-1/tasks?

Policies: [paste all .cedar files]
Principal: API::User::"bob"
Action: API::Action::"GET"
Resource: API::Endpoint::"req"
Entities: [paste entities/users-and-roles.json, then add this endpoint entity:
  { "uid": { "type": "API::Endpoint", "id": "req" },
    "attrs": { "path": "/api/v1/projects/proj-1/tasks", "method": "GET" },
    "parents": [] }]
Schema: [paste schema.json]
```

Expected: **Deny** — `/api/v1/projects/proj-1/tasks` is two levels deep. The `&&` condition fails because the path matches `like "/api/v1/projects/*/*"`, so `!(like "/api/v1/projects/*/*")` is false.

```
Would Charlie be allowed to GET /api/v1/projects/proj-1/tasks?
```

Expected: **Allow** — the `viewer-readonly` policy has no depth limit. Charlie can GET at any depth.

### cedar_explain

```
Explain this Cedar policy:

permit (
  principal in API::Role::"developer",
  action in [API::Action::"GET", API::Action::"POST"],
  resource
)
when {
  resource.path == "/api/v1/projects"
  || (
    resource.path like "/api/v1/projects/*"
    && !(resource.path like "/api/v1/projects/*/*")
  )
};
```

Expected: a breakdown showing the two-part `||` condition — exact match at collection level, plus depth-limited path match — with the `like` patterns rendered as Cedar syntax.

### cedar_generate_sample_request

```
Generate a sample request that would be ALLOWED by this policy:

permit (
  principal in API::Role::"developer",
  action in [API::Action::"GET", API::Action::"POST"],
  resource
)
when {
  resource.path == "/api/v1/projects"
  || (
    resource.path like "/api/v1/projects/*"
    && !(resource.path like "/api/v1/projects/*/*")
  )
};

Schema: [paste schema.json]
Target decision: allow
```

Expected: a path like `/api/v1/projects` or `/api/v1/projects/x` (one level deep).

```
Generate a sample request that would be DENIED.
Target decision: deny
```

Expected: a path like `/api/v1/projects/x/x` — two levels deep, which satisfies the negative `like` pattern and makes `!(like "/api/v1/projects/*/*")` false.

---

## Test cases

| Principal | Action | Path | Expected | Reason |
|-----------|--------|------|----------|--------|
| alice (admin) | DELETE | /api/v1/projects/proj-1 | **Allow** | Admin policy permits everything |
| bob (developer) | GET | /api/v1/projects | **Allow** | Exact collection match |
| bob (developer) | POST | /api/v1/projects/proj-1 | **Allow** | One level deep, POST permitted |
| bob (developer) | GET | /api/v1/projects/proj-1/tasks | **Deny** | Two levels deep, depth limit triggered |
| bob (developer) | DELETE | /api/v1/projects | **Deny** | DELETE not in developer action list |
| charlie (viewer) | GET | /api/v1/projects/proj-1 | **Allow** | Viewer can GET one level |
| charlie (viewer) | GET | /api/v1/projects/proj-1/tasks | **Allow** | Viewer has no depth limit |
| charlie (viewer) | POST | /api/v1/projects | **Deny** | Viewer cannot POST |

---

## Common pitfalls in this pattern

**Cedar `*` matches `/`** — unlike shell globs or URL matchers, Cedar's `*` wildcard matches any character sequence including path separators. `like "/api/v1/*"` matches `/api/v1/projects/proj-1/tasks/comments`. Depth limiting requires explicit negation: `&& !(like "/api/v1/projects/*/*")`.

**Viewer and developer have different depth semantics — intentionally.** The developer policy has depth-limiting because developers are expected to act on individual resources, not traverse sub-resource trees. The viewer policy has no depth limit because read-only access to deeper paths is lower risk. This is a deliberate design choice, not an oversight.

**Path matching is evaluated at request time, not at policy store creation.** The `resource.path` attribute comes from your entity store — the value your application puts there when building the authorization request. Cedar does not parse URLs. If your application sends `path: "/api/v1/projects/proj-1"` in the entity, that is what Cedar evaluates. Normalizing paths (trailing slash, URL encoding) is your application's responsibility.

**Action names are Cedar entity IDs, not HTTP methods.** `API::Action::"GET"` is a Cedar entity identifier that happens to be named `GET`. You decide the mapping between Cedar action IDs and HTTP methods in your application layer. Cedar doesn't know what HTTP is.
