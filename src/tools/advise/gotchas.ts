/**
 * Cedar / AVP gotcha catalog.
 * Drawn from 03-cedar-developer-guide.md and the AVP validation error categories.
 */

export interface Gotcha {
  id: string;
  severity: "high" | "medium" | "info";
  description: string;
  avp_error_category?: string;
  keywords: string[];  // Used to match gotchas to intent keywords
}

export const GOTCHA_CATALOG: Gotcha[] = [
  {
    id: "optional_attribute_guard",
    severity: "high",
    description: "Optional schema attributes MUST be guarded with `entity has attr` before access. Without the guard, Cedar silently skips the policy for any entity missing the attribute — no error, just no match. This is one of the most common silent bugs in Cedar.",
    avp_error_category: "UnsafeOptionalAttributeAccess",
    keywords: ["optional", "has", "attribute", "guard", "email", "verified", "nullable"],
  },
  {
    id: "forbid_overrides_permit",
    severity: "high",
    description: "A single matching `forbid` policy overrides ALL matching `permit` policies. There is no priority or weight system. Use `unless` to create exemptions inside the forbid itself.",
    keywords: ["forbid", "block", "deny", "sensitive", "secret", "top_secret", "restrict"],
  },
  {
    id: "avp_in_place_limitation",
    severity: "high",
    description: "AVP UpdatePolicy cannot change: effect (permit↔forbid), principal scope, or resource scope. These require deleting the old policy and creating a new one. Plan your deployment accordingly.",
    avp_error_category: "ResourceNotFoundException",
    keywords: ["change", "update", "modify", "rename", "role", "principal", "resource", "effect"],
  },
  {
    id: "like_wildcard_crosses_slash",
    severity: "medium",
    description: "Cedar's `like` wildcard `*` matches ANY character sequence including `/`. To limit path depth, combine a positive `like` with a negated `like` for deeper patterns. Example: `resource.path like '/api/v1/*' && !(resource.path like '/api/v1/*/*')`.",
    keywords: ["path", "like", "url", "endpoint", "api", "depth", "wildcard", "route"],
  },
  {
    id: "array_containment_syntax",
    severity: "medium",
    description: "Cedar array containment is left-first: `[\"a\", \"b\"].contains(attr)` — the ARRAY is on the left. Writing `attr in [\"a\", \"b\"]` is an entity-hierarchy check, not a value containment check.",
    keywords: ["contains", "list", "array", "set", "allowlist", "in"],
  },
  {
    id: "schema_first_then_policy",
    severity: "medium",
    description: "Schema changes must be deployed BEFORE policies that reference new attributes or types. AVP validates policies against the current schema at creation/update time. Deploying a policy before its schema change causes UnrecognizedEntityType or MissingAttribute errors.",
    avp_error_category: "MissingAttribute",
    keywords: ["schema", "attribute", "entity", "add", "new", "field"],
  },
  {
    id: "default_deny",
    severity: "info",
    description: "Cedar is default-deny. A request is denied unless at least one `permit` policy explicitly matches AND no `forbid` policy matches. There is no 'allow by default' mode.",
    keywords: ["deny", "block", "default", "access"],
  },
  {
    id: "rebac_migration_data",
    severity: "medium",
    description: "Migrating from RBAC to ReBAC (relationship-based) requires populating relationship attributes on existing resources BEFORE deploying the new policy. Without the data, the policy will deny all access for resources without the relationship attribute.",
    keywords: ["owner", "owners", "relationship", "rebac", "migrate", "per-document", "per-resource"],
  },
  {
    id: "avp_single_namespace",
    severity: "info",
    description: "AVP policy stores support only one namespace per schema. If your Cedar policies use multiple namespaces locally, they cannot be deployed to a single AVP policy store.",
    keywords: ["namespace", "avp", "deploy"],
  },
  {
    id: "action_groups_not_automatic",
    severity: "medium",
    description: "Action group entities must be included in the entity list when evaluating locally. AVP adds them automatically, but local evaluation via WASM (and this tool) does not. Pass action group entities explicitly in your entity list.",
    keywords: ["action", "group", "batch", "evaluate", "test"],
  },
];

/** Select relevant gotchas by matching intent keywords. */
export function selectGotchas(intent: string, maxCount = 5): Gotcha[] {
  const lower = intent.toLowerCase();
  const scored = GOTCHA_CATALOG.map(g => ({
    gotcha: g,
    score: g.keywords.filter(kw => lower.includes(kw)).length,
  }));
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.gotcha.severity === "high" ? -1 : 1))
    .slice(0, maxCount)
    .map(s => s.gotcha);
}
