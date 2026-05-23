# Coming fresh to Cedar?

Cedar is a policy language built around three entities: a **principal** (who's asking), an **action** (what they want to do), and a **resource** (what they want to do it to). Authorization is the question: does a `permit` policy match this triple, without any `forbid` policy blocking it?

A few things that shape how you write policies.

Cedar uses **default deny**: every request is denied unless a `permit` policy explicitly matches. There is no "allow by default" option.

A matching **`forbid`** policy overrides every `permit`. A single matching `forbid` blocks the request regardless of how many `permit` policies also match. If you need an exception to a `forbid`, use `unless`:

```cedar
forbid (principal, action, resource)
when { resource.classification == "top_secret" }
unless { principal in MyApp::Role::"admin" };
```

Namespaces are part of entity type names. `MyApp::User::"alice"` is the canonical form: the double colon separates namespace from type, and the quoted string is the entity ID.

Start with `cedar_advise`. Describe what you want in plain language and let the server produce a starting policy. Then validate it with `cedar_validate` and verify the decision with `cedar_authorize`.

The upstream [Cedar documentation](https://docs.cedarpolicy.com) and [Cedar policy patterns](https://docs.cedarpolicy.com/overview/patterns.html) are the authoritative reference.
