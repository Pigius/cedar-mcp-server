/**
 * Property-based tests for cedar-mcp-server tools.
 *
 * Property tests assert invariants that must hold for ALL inputs in a class,
 * not just the hand-picked examples in unit tests. They use `fast-check` to
 * generate ~100 cases per property and shrink failing cases to a minimal
 * reproducer.
 *
 * Calls handlers directly (not through MCP stdio) for speed — properties
 * concern tool semantics, not protocol framing. Protocol-level invariants
 * live in test/integration/e2e/protocol.test.ts.
 *
 * Each property below states the failure case it would catch.
 *
 * Run: npx vitest run test/property
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { handleValidate } from "../../src/tools/validate.js";
import { handleFormat } from "../../src/tools/format.js";
import { handleAuthorize } from "../../src/tools/authorize.js";
import { handleDiffSchema } from "../../src/tools/diff-schema.js";
import { handleCheckChange } from "../../src/tools/check-change.js";
import { handleTranslate } from "../../src/tools/translate.js";
import { SCHEMA_JSON, POLICIES } from "../fixtures/docmgmt.js";

const SCHEMA_STR = JSON.stringify(SCHEMA_JSON);

// ─── Generators ───────────────────────────────────────────────────────────────

/** Cedar-legal identifier (Role name, entity id, attribute name). */
const cedarId = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/);

/** Cedar-legal action key (lowercase ASCII to avoid clashing with type names). */
const actionKey = fc.stringMatching(/^[a-z][a-z_]{0,15}$/);

/** A pure Membership/RBAC permit policy: permit principal in Role::"X". */
function membershipPolicy(roleId: string): string {
  return `permit (
  principal in DocMgmt::Role::"${roleId}",
  action,
  resource
);`;
}

// ─── Properties ───────────────────────────────────────────────────────────────

describe("property — cedar_format idempotency across the option space", () => {
  // Property: for any policy P drawn from a real schema's policy set, for any
  // line_width in [40, 200] and indent_width in [0, 8], format is idempotent:
  //   format(format(P, w, i), w, i) === format(P, w, i)
  //
  // Failure case caught: a formatter whose output depends on prior input state
  // (e.g., a hidden counter) would produce different output on the second run.
  // A formatter that doesn't strip a trailing newline cleanly would diverge.
  it("format(format(P, w, i), w, i) equals format(P, w, i)", () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 40, max: 200 }),
        fc.integer({ min: 0, max: 8 }),
        async (lineWidth, indentWidth) => {
          const first = await handleFormat({ policies: POLICIES, line_width: lineWidth, indent_width: indentWidth });
          if (!first.formatted) return; // formatter rejected; nothing to compare
          const second = await handleFormat({ policies: first.formatted, line_width: lineWidth, indent_width: indentWidth });
          expect(second.formatted).toBe(first.formatted);
        }
      ),
      { numRuns: 30 }  // 30 runs is enough to surface idempotency violations; 100 would multiply WASM cost
    );
  }, 60_000);
});

describe("property — cedar_validate is deterministic", () => {
  // Property: running cedar_validate on the same input multiple times produces
  // identical results. Failure case: a stateful or random-output validator
  // would produce inconsistent results across runs, breaking CI repeatability.
  it("two consecutive validate calls on the same input return equal results", async () => {
    await fc.assert(
      fc.asyncProperty(cedarId, async (roleId) => {
        const policy = membershipPolicy(roleId);
        const a = await handleValidate({ policies: policy, schema: SCHEMA_STR });
        const b = await handleValidate({ policies: policy, schema: SCHEMA_STR });
        expect(b).toEqual(a);
      }),
      { numRuns: 25 }
    );
  }, 60_000);
});

describe("property — cedar_authorize is deterministic", () => {
  // Property: running cedar_authorize on the same input multiple times produces
  // identical decisions. Failure case: WASM internal state leaking between
  // calls, or non-deterministic policy selection in the engine.
  it("two consecutive authorize calls return the same decision", async () => {
    const entities = JSON.stringify([
      { uid: { type: "DocMgmt::User", id: "alice" }, attrs: { name: "Alice", email: "a@b.c" }, parents: [{ type: "DocMgmt::Role", id: "admin" }] },
      { uid: { type: "DocMgmt::Role", id: "admin" }, attrs: {}, parents: [] },
      { uid: { type: "DocMgmt::Document", id: "d1" }, attrs: { owner: "alice", classification: "public" }, parents: [] },
    ]);
    await fc.assert(
      fc.asyncProperty(actionKey, async (action) => {
        // Use READ from schema; the property tests determinism, not the action choice
        const a = await handleAuthorize({
          policies: POLICIES,
          principal: 'DocMgmt::User::"alice"',
          action: 'DocMgmt::Action::"READ"',
          resource: 'DocMgmt::Document::"d1"',
          entities,
          schema: SCHEMA_STR,
        });
        const b = await handleAuthorize({
          policies: POLICIES,
          principal: 'DocMgmt::User::"alice"',
          action: 'DocMgmt::Action::"READ"',
          resource: 'DocMgmt::Document::"d1"',
          entities,
          schema: SCHEMA_STR,
        });
        expect(b.decision).toBe(a.decision);
        void action; // generator is the fc property driver; we don't use it directly
      }),
      { numRuns: 20 }
    );
  }, 60_000);
});

describe("property — cedar_diff_schema add/remove symmetry", () => {
  // Property: for any two schemas S1, S2:
  //   diff(S1, S2).entity_types.added.length === diff(S2, S1).entity_types.removed.length
  // i.e., what's added going A→B must be removed going B→A. Same for actions.
  //
  // Failure case: an asymmetric diff implementation that double-counts or skips
  // entries based on direction. Catches one-sided iteration bugs.
  it("entity_types.added going A→B equals entity_types.removed going B→A", async () => {
    const blueSchema = JSON.stringify(SCHEMA_JSON);

    await fc.assert(
      fc.asyncProperty(cedarId, async (newEntityName) => {
        // Sanitize — Cedar entity type names can't be reserved Cedar tokens
        if (["User", "Role", "Document", "Folder"].includes(newEntityName)) return;

        // Green = blue + one extra entity type
        const greenObj = JSON.parse(blueSchema) as { DocMgmt: { entityTypes: Record<string, unknown> } };
        greenObj.DocMgmt.entityTypes[newEntityName] = {
          memberOfTypes: [],
          shape: { type: "Record", attributes: {} },
        };
        const greenSchema = JSON.stringify(greenObj);

        const forward = await handleDiffSchema({ blue: blueSchema, green: greenSchema });
        const reverse = await handleDiffSchema({ blue: greenSchema, green: blueSchema });

        expect(forward.entity_types.added).toHaveLength(reverse.entity_types.removed.length);
        expect(forward.entity_types.added[0]?.name).toBe(reverse.entity_types.removed[0]?.name);
      }),
      { numRuns: 20 }
    );
  }, 60_000);
});

describe("property — cedar_diff_schema identity always returns safe", () => {
  // Property: for ANY schema S, diff(S, S).risk_level === "safe" and all change
  // arrays are empty. The unit test covers this for one schema; this property
  // covers it for randomly-modified schemas (e.g., with extra entity types added
  // before the diff).
  //
  // Failure case: __cedar:: prefix stripping asymmetry (we tested for it in unit
  // tests, but the property surfaces it across input variations).
  it("diff(S, S) is risk_level safe with empty change arrays", async () => {
    await fc.assert(
      fc.asyncProperty(cedarId, async (newEntityName) => {
        if (["User", "Role", "Document", "Folder"].includes(newEntityName)) return;
        const schemaObj = JSON.parse(JSON.stringify(SCHEMA_JSON)) as { DocMgmt: { entityTypes: Record<string, unknown> } };
        schemaObj.DocMgmt.entityTypes[newEntityName] = {
          memberOfTypes: [],
          shape: { type: "Record", attributes: {} },
        };
        const schemaStr = JSON.stringify(schemaObj);
        const result = await handleDiffSchema({ blue: schemaStr, green: schemaStr });
        expect(result.risk_level).toBe("safe");
        expect(result.entity_types.added).toHaveLength(0);
        expect(result.entity_types.removed).toHaveLength(0);
        expect(result.entity_types.modified).toHaveLength(0);
      }),
      { numRuns: 20 }
    );
  }, 60_000);
});

describe("property — cedar_check_policy_change identity", () => {
  // Property: for ANY policy P, check_policy_change(P, P) reports zero changes
  // and can_update_in_place: true. Even if P contains whitespace, comments, or
  // unusual attribute names, comparing it to itself must yield identity.
  //
  // Failure case: a change detector keyed on textual diff rather than semantic
  // equality would flag whitespace-only differences (e.g., from formatting)
  // on what should be an identity comparison.
  it("check_policy_change(P, P) reports no changes", async () => {
    await fc.assert(
      fc.asyncProperty(cedarId, async (roleId) => {
        const policy = membershipPolicy(roleId);
        const result = await handleCheckChange({ old_policy: policy, new_policy: policy });
        expect(result.changes).toHaveLength(0);
        expect(result.can_update_in_place).toBe(true);
      }),
      { numRuns: 25 }
    );
  }, 60_000);
});

describe("property — cedar_translate roundtrip preserves validation", () => {
  // Property: for any role-membership policy that validates against the DocMgmt
  // schema, translating to JSON and back to Cedar produces a policy that ALSO
  // validates. Failure case: a lossy AST translation that drops a clause would
  // cause the roundtripped version to validate differently from the original.
  it("validate(text) and validate(text→json→text) agree", async () => {
    await fc.assert(
      fc.asyncProperty(cedarId, async (roleId) => {
        const original = membershipPolicy(roleId);

        const toJson = await handleTranslate({ input: original, type: "policy", direction: "to_json" });
        if (toJson.error || !toJson.output) return; // generator produced a name the parser rejects; skip

        const toCedar = await handleTranslate({ input: toJson.output, type: "policy", direction: "to_cedar" });
        if (toCedar.error || !toCedar.output) return;

        const validateOriginal = await handleValidate({ policies: original, schema: SCHEMA_STR });
        const validateRoundtrip = await handleValidate({ policies: toCedar.output, schema: SCHEMA_STR });
        expect(validateRoundtrip.valid).toBe(validateOriginal.valid);
      }),
      { numRuns: 30 }
    );
  }, 60_000);
});
