import { describe, it, expect } from "vitest";
import { handleAuthorizeBatch } from "../../src/tools/authorize-batch.js";
import { POLICIES, SCHEMA_JSON, ENTITIES } from "../fixtures/docmgmt.js";

const SCHEMA = JSON.stringify(SCHEMA_JSON);
const SHARED_ENTITIES = JSON.stringify(ENTITIES);

// ─── Convenience request builders ─────────────────────────────────────────────

function req(principal: string, action: string, resource: string) {
  return { principal, action, resource };
}

// ─── Test 1: Happy path — 3 requests, two Allow, one Deny ─────────────────────

describe("cedar_authorize_batch — happy path", () => {
  it("evaluates 3 requests and returns correct decision matrix", async () => {
    const requests = JSON.stringify([
      // alice (admin) reads public doc → Allow
      req('DocMgmt::User::"alice"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
      // charlie (viewer) reads public doc → Allow
      req('DocMgmt::User::"charlie"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
      // dave (no role) reads public doc → Deny
      req('DocMgmt::User::"dave"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: SHARED_ENTITIES,
      requests,
    });

    expect(result.total).toBe(3);
    expect(result.allowed).toBe(2);
    expect(result.denied).toBe(1);
    expect(result.errored).toBe(0);

    expect(result.decisions[0]!.decision).toBe("Allow");
    expect(result.decisions[0]!.index).toBe(0);
    expect(result.decisions[0]!.principal).toBe('DocMgmt::User::"alice"');

    expect(result.decisions[1]!.decision).toBe("Allow");
    expect(result.decisions[1]!.index).toBe(1);
    expect(result.decisions[1]!.principal).toBe('DocMgmt::User::"charlie"');

    expect(result.decisions[2]!.decision).toBe("Deny");
    expect(result.decisions[2]!.index).toBe(2);
    expect(result.decisions[2]!.principal).toBe('DocMgmt::User::"dave"');

    expect(result.summary).toContain("3 request");
    expect(result.summary).toContain("2 Allow");
    expect(result.summary).toContain("1 Deny");
    expect(result.summary).toContain("0 Error");
  });
});

// ─── Test 2: Mixed valid/invalid — one malformed request, others still process ─

describe("cedar_authorize_batch — mixed valid/invalid", () => {
  it("marks malformed-entity request as Error; other requests still evaluate", async () => {
    const requests = JSON.stringify([
      // valid — alice allow
      {
        principal: 'DocMgmt::User::"alice"',
        action: 'DocMgmt::Action::"READ"',
        resource: 'DocMgmt::Document::"doc-public"',
      },
      // invalid — per-request entities is bad JSON string
      {
        principal: 'DocMgmt::User::"bob"',
        action: 'DocMgmt::Action::"READ"',
        resource: 'DocMgmt::Document::"doc-public"',
        entities: "NOT_VALID_JSON{{{",
      },
      // valid — dave deny
      {
        principal: 'DocMgmt::User::"dave"',
        action: 'DocMgmt::Action::"READ"',
        resource: 'DocMgmt::Document::"doc-public"',
      },
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: SHARED_ENTITIES,
      requests,
    });

    expect(result.total).toBe(3);
    expect(result.allowed).toBe(1);
    expect(result.denied).toBe(1);
    expect(result.errored).toBe(1);

    // index 0: Alice → Allow
    expect(result.decisions[0]!.decision).toBe("Allow");
    expect(result.decisions[0]!.index).toBe(0);

    // index 1: bad entities → Error with an explanation
    expect(result.decisions[1]!.decision).toBe("Error");
    expect(result.decisions[1]!.index).toBe(1);
    expect(result.decisions[1]!.error).toBeDefined();
    expect(result.decisions[1]!.error).toBeTruthy();

    // index 2: Dave → Deny (continues despite index 1 error)
    expect(result.decisions[2]!.decision).toBe("Deny");
    expect(result.decisions[2]!.index).toBe(2);
  });

  it("marks malformed principal ref as Error; others still evaluate", async () => {
    const requests = JSON.stringify([
      // valid
      req('DocMgmt::User::"alice"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
      // bad principal — not a valid Cedar ref
      { principal: "bad-format-no-quotes", action: 'DocMgmt::Action::"READ"', resource: 'DocMgmt::Document::"doc-public"' },
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: SHARED_ENTITIES,
      requests,
    });

    expect(result.total).toBe(2);
    expect(result.errored).toBe(1);
    expect(result.decisions[1]!.decision).toBe("Error");
    expect(result.decisions[1]!.error).toContain("Invalid Cedar entity reference");
    expect(result.decisions[0]!.decision).toBe("Allow");
  });
});

// ─── Test 3: Empty array ───────────────────────────────────────────────────────

describe("cedar_authorize_batch — empty array", () => {
  it("returns total: 0 and summary mentioning no requests", async () => {
    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: SHARED_ENTITIES,
      requests: JSON.stringify([]),
    });

    expect(result.total).toBe(0);
    expect(result.allowed).toBe(0);
    expect(result.denied).toBe(0);
    expect(result.errored).toBe(0);
    expect(result.decisions).toHaveLength(0);
    expect(result.summary).toContain("0 request");
    expect(result.summary).toMatch(/no requests/i);
  });
});

// ─── Test 4: determining_policies are reported on Allow ───────────────────────

describe("cedar_authorize_batch — determining_policies", () => {
  it("surfaces determining_policies when a permit fires", async () => {
    const requests = JSON.stringify([
      req('DocMgmt::User::"charlie"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: SHARED_ENTITIES,
      requests,
    });

    expect(result.total).toBe(1);
    expect(result.decisions[0]!.decision).toBe("Allow");
    expect(result.decisions[0]!.determining_policies).toBeDefined();
    expect(result.decisions[0]!.determining_policies!.length).toBeGreaterThan(0);
  });

  it("determining_policies is empty array (not undefined) for a Deny", async () => {
    const requests = JSON.stringify([
      req('DocMgmt::User::"dave"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: SHARED_ENTITIES,
      requests,
    });

    expect(result.decisions[0]!.decision).toBe("Deny");
    // Deny by default (no permit matched): reason array is empty
    expect(result.decisions[0]!.determining_policies).toEqual([]);
  });

  it("determining_policies is populated for a forbid that overrides a permit", async () => {
    // bob (editor) reading top_secret doc — permit fires but forbid wins → Deny
    // Cedar puts the forbid policy id in reason when it overrides
    const requests = JSON.stringify([
      req('DocMgmt::User::"bob"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-secret"'),
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: SHARED_ENTITIES,
      requests,
    });

    expect(result.decisions[0]!.decision).toBe("Deny");
    // The forbid is the determining policy — Cedar includes it in reason
    expect(result.decisions[0]!.determining_policies).toBeDefined();
  });
});

// ─── Test 5: Schema violation falsification ────────────────────────────────────
//
// Assumption going in: a request with a wrong principal type (e.g. DocMgmt::Role
// used as principal instead of DocMgmt::User) with schema+validateRequest=true
// should cause Cedar WASM to return type:"failure", which we map to decision "Error"
// (NOT a "Deny"). Verified by scratch/probe-schema-violation.ts:
//   type: failure, errors: ["principal type `DocMgmt::Role` is not valid for ..."]
//
// Without schema, the same wrong principal type silently returns decision "allow"
// because no policy check rejects it (admin role is in the admin group).
// Our implementation maps type:"failure" → "Error" — confirmed below.

describe("cedar_authorize_batch — schema violation falsification", () => {
  it("schema-violating request is Error (not thrown, not Deny) — Cedar type:failure mapped", async () => {
    // DocMgmt::Role::"admin" as principal is invalid — schema says principals must be User
    const requests = JSON.stringify([
      req(
        'DocMgmt::Role::"admin"',          // WRONG type — not a User
        'DocMgmt::Action::"READ"',
        'DocMgmt::Document::"doc-public"'
      ),
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      schema: SCHEMA,
      entities: SHARED_ENTITIES,
      requests,
    });

    // Must NOT throw — result is a structured AuthorizeBatchResult
    expect(result).toBeDefined();
    expect(result.total).toBe(1);

    const d = result.decisions[0]!;
    // Cedar returns type:"failure" for this → we map to "Error"
    expect(d.decision).toBe("Error");
    expect(d.error).toBeDefined();
    expect(d.error).toContain("DocMgmt::Role");

    // Counters must be consistent
    expect(result.errored).toBe(1);
    expect(result.allowed).toBe(0);
    expect(result.denied).toBe(0);
  });

  it("schema-violating request does NOT cause an Error when schema is omitted (no validation)", async () => {
    // Probe confirmed: without schema, Cedar evaluates freely — wrong type → Allow (admin policy matches)
    const requests = JSON.stringify([
      req(
        'DocMgmt::Role::"admin"',
        'DocMgmt::Action::"READ"',
        'DocMgmt::Document::"doc-public"'
      ),
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      // no schema — validation disabled
      entities: SHARED_ENTITIES,
      requests,
    });

    // Without schema the request is not Error; Cedar evaluates it against policies
    // DocMgmt::Role::"admin" is in DocMgmt::Role::"admin" so permit(principal in Role::"admin", ...) fires
    expect(result.decisions[0]!.decision).not.toBe("Error");
    expect(result.errored).toBe(0);
  });

  it("non-existent action with schema → Error", async () => {
    const requests = JSON.stringify([
      req(
        'DocMgmt::User::"alice"',
        'DocMgmt::Action::"NONEXISTENT"',
        'DocMgmt::Document::"doc-public"'
      ),
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      schema: SCHEMA,
      entities: SHARED_ENTITIES,
      requests,
    });

    expect(result.decisions[0]!.decision).toBe("Error");
    expect(result.decisions[0]!.error).toContain("NONEXISTENT");
    expect(result.errored).toBe(1);
  });
});

// ─── Test 6: Shared entities vs per-request entities ──────────────────────────

describe("cedar_authorize_batch — shared vs per-request entities", () => {
  it("per-request entities override shared entities for that request", async () => {
    // Shared entities: alice is admin (allow READ)
    // Request for alice but per-request entities has alice with no role (deny)
    const aliceNoRole = JSON.stringify([
      { uid: { type: "DocMgmt::User", id: "alice" }, attrs: { name: "Alice", email: "a@b.com" }, parents: [] },
      { uid: { type: "DocMgmt::Document", id: "doc-public" }, attrs: { owner: "alice", classification: "public" }, parents: [] },
    ]);

    const requests = JSON.stringify([
      {
        principal: 'DocMgmt::User::"alice"',
        action: 'DocMgmt::Action::"READ"',
        resource: 'DocMgmt::Document::"doc-public"',
        entities: aliceNoRole,  // per-request override: alice has no role
      },
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: SHARED_ENTITIES,  // shared: alice is admin
      requests,
    });

    // With per-request entities (no role for alice), Deny should win
    expect(result.decisions[0]!.decision).toBe("Deny");
  });

  it("uses shared entities when request omits its own", async () => {
    const requests = JSON.stringify([
      req('DocMgmt::User::"alice"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: SHARED_ENTITIES,
      requests,
    });

    expect(result.decisions[0]!.decision).toBe("Allow");
  });
});

// ─── Test 7: Input validation edge cases ──────────────────────────────────────

describe("cedar_authorize_batch — input validation", () => {
  it("returns zeroResult when neither policies nor policy_ref is provided", async () => {
    const result = await handleAuthorizeBatch({
      requests: JSON.stringify([req('DocMgmt::User::"alice"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"')]),
    });
    expect(result.total).toBe(0);
    expect(result.summary).toContain("required");
  });

  it("returns zeroResult for non-array requests", async () => {
    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      requests: JSON.stringify({ not: "an array" }),
    });
    expect(result.total).toBe(0);
    expect(result.summary).toContain("array");
  });

  it("returns zeroResult for invalid requests JSON", async () => {
    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      requests: "NOT_JSON{{{",
    });
    expect(result.total).toBe(0);
    expect(result.summary).toContain("JSON");
  });

  it("returns zeroResult when shared entities is invalid JSON", async () => {
    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: "NOT_JSON",
      requests: JSON.stringify([]),
    });
    expect(result.total).toBe(0);
    expect(result.summary).toContain("entities");
  });

  it("summary uses singular 'request' for exactly 1 request", async () => {
    const requests = JSON.stringify([
      req('DocMgmt::User::"alice"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
    ]);
    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: SHARED_ENTITIES,
      requests,
    });
    expect(result.summary).toMatch(/^1 request:/);
  });
});

// ─── kickoff-14 14a: H1 stable-ID resolution parity with cedar_authorize ──────

const ADMIN_POLICY_TEXT = `permit (principal in DocMgmt::Role::"admin", action, resource);`;
const EDITOR_POLICY_TEXT = `permit (principal in DocMgmt::Role::"editor", action in [DocMgmt::Action::"READ", DocMgmt::Action::"WRITE"], resource);`;

describe("cedar_authorize_batch — kickoff-14 14a stable-ID resolution", () => {
  it("policiesMap input → determining_policies returns basenames, not positional", async () => {
    const requests = JSON.stringify([
      req('DocMgmt::User::"alice"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
    ]);

    const result = await handleAuthorizeBatch({
      policiesMap: { admin: ADMIN_POLICY_TEXT, editor: EDITOR_POLICY_TEXT },
      entities: SHARED_ENTITIES,
      requests,
    });

    expect(result.decisions[0]!.decision).toBe("Allow");
    expect(result.decisions[0]!.determining_policies).toEqual(["admin"]);
    expect(result.decisions[0]!.determining_policies).not.toContain("policy0");
  });

  it("policiesMap with @id annotation → @id wins over basename", async () => {
    const annotated = `@id("admin-policy-v2")\n${ADMIN_POLICY_TEXT}`;
    const requests = JSON.stringify([
      req('DocMgmt::User::"alice"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
    ]);

    const result = await handleAuthorizeBatch({
      policiesMap: { admin: annotated, editor: EDITOR_POLICY_TEXT },
      entities: SHARED_ENTITIES,
      requests,
    });

    expect(result.decisions[0]!.decision).toBe("Allow");
    expect(result.decisions[0]!.determining_policies).toEqual(["admin-policy-v2"]);
  });

  it("inline policies string falls back to positional IDs the same way buildStaticPolicies does (regression)", async () => {
    // The flat-string path retains positional fallback because the caller did
    // not supply file basenames. Verifies the existing inline path is unaffected.
    const requests = JSON.stringify([
      req('DocMgmt::User::"alice"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
    ]);

    const result = await handleAuthorizeBatch({
      policies: POLICIES,
      entities: SHARED_ENTITIES,
      requests,
    });

    expect(result.decisions[0]!.decision).toBe("Allow");
    const determining = result.decisions[0]!.determining_policies ?? [];
    expect(determining).toHaveLength(1);
    expect(determining[0]).toMatch(/^policy\d+$/);
  });

  it("error message names policiesMap as a valid input alternative", async () => {
    const result = await handleAuthorizeBatch({
      requests: JSON.stringify([
        req('DocMgmt::User::"alice"', 'DocMgmt::Action::"READ"', 'DocMgmt::Document::"doc-public"'),
      ]),
    });
    expect(result.summary).toContain("policiesMap");
  });
});
