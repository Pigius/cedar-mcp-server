import { validate, checkParsePolicySet, policySetTextToParts } from "@cedar-policy/cedar-wasm/nodejs";
import type { Schema, DetailedError } from "@cedar-policy/cedar-wasm/nodejs";
import { storeManager } from "../resources/store-manager.js";

export interface ValidateInput {
  policies: string;
  /** Optional. When omitted, validate runs in syntax-only mode (parse-only, no schema typing). */
  schema?: string;
  /**
   * Optional store name to disambiguate workspace auto-discovery (10d) when
   * multiple stores are loaded. The server.ts handler resolves this against
   * the StoreManager and supplies `schema` before calling handleValidate; the
   * field is carried through so handleValidate can surface ambiguity errors
   * when callers invoke it directly without going through the MCP layer.
   */
  store?: string;
  /**
   * 11c opt-in: explicitly select the validation mode rather than letting
   * schema presence decide it.
   *
   * "auto" (default): schema presence picks the mode. With a schema (inline
   *   or auto-discovered from a single loaded store), run syntax_and_schema.
   *   Without one, run syntax_only.
   * "syntax_only": always parser-only. Skip workspace auto-discovery and
   *   ignore any inline schema. Useful when the user explicitly says "I have
   *   no schema" or wants a fast syntax sanity check.
   * "syntax_and_schema": require a schema. If neither an inline schema nor
   *   one resolvable from a loaded store is available, return a clear error
   *   rather than silently dropping to syntax_only.
   */
  validation_mode?: "auto" | "syntax_only" | "syntax_and_schema";
}

export interface ValidateError {
  policy_id: string;
  message: string;
  hint: string | null;
  /** 1-indexed line of the source location, when the WASM error reports one. */
  line?: number;
  /** 1-indexed column of the source location, when the WASM error reports one. */
  column?: number;
}

export interface ValidateResult {
  valid: boolean;
  errors: ValidateError[];
  warnings: ValidateError[];
  policy_count: number;
  /**
   * Discriminator that tells the caller what was actually checked.
   * "syntax_only": parser-only run, no schema supplied. Catches parse errors
   *   (typos, malformed scopes, bad operators) but not attribute typing or
   *   action applicability.
   * "syntax_and_schema": full parse + type-check against a Cedar schema.
   */
  validation_mode: "syntax_only" | "syntax_and_schema";
  /**
   * 10d workspace auto-discovery: populated when an input was sourced from a
   * loaded MCP root rather than supplied inline. Surfaces to the caller which
   * store ended up satisfying the missing field so the action is traceable.
   */
  auto_discovered?: {
    schema_from?: string;
  };
}

/**
 * Common Cedar typo → suggestion table. Used to populate the `hint` field on
 * parse errors of the form "unexpected token `X`" when X is a known misspelling
 * of a Cedar keyword. Keep small and conservative; better to leave hint null
 * than to over-suggest. Levenshtein over the reserved keyword set is the
 * future generalization if this table proves too narrow.
 */
const TYPO_HINTS: Record<string, string> = {
  int: "in",
  permint: "permit",
  forbit: "forbid",
  prinipal: "principal",
  prinicpal: "principal",
  prncipal: "principal",
  resorce: "resource",
  resoure: "resource",
  actoin: "action",
  acton: "action",
  unles: "unless",
  wen: "when",
  Like: "like",
  Has: "has",
  Permit: "permit",
  Forbid: "forbid",
  When: "when",
  Unless: "unless",
};

function parseSchema(schemaStr: string): Schema {
  try {
    return JSON.parse(schemaStr);
  } catch {
    // Not JSON — treat as Cedar schema text
    return schemaStr;
  }
}

function countPolicies(policiesText: string): number {
  const parts = policySetTextToParts(policiesText);
  if (parts.type === "failure") return 0;
  return parts.policies.length + parts.policy_templates.length;
}

/**
 * Convert a WASM-reported UTF-8 byte offset into the source text into a
 * 1-indexed line + Unicode-code-point column. Walking the JS string as if
 * the offset were a char index drifts whenever the source contains
 * multi-byte UTF-8 chars (em-dashes in comments, non-ASCII identifiers
 * in string literals). This matters in practice for any Cedar policy
 * with non-ASCII content, including comments, before the error site.
 *
 * Implementation: encode the full source to bytes, slice up to the
 * byte offset, decode back to a string, then count Unicode code points
 * (via for-of, which iterates code points rather than UTF-16 code units).
 */
function offsetToLineCol(source: string, byteOffset: number): { line: number; column: number } {
  const enc = new TextEncoder();
  const bytes = enc.encode(source);
  if (byteOffset < 0 || byteOffset > bytes.length) {
    return { line: 1, column: 1 };
  }
  const before = new TextDecoder().decode(bytes.slice(0, byteOffset));
  let line = 1;
  let column = 1;
  for (const ch of before) {
    if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/**
 * Pull the offending token out of a Cedar parse error message, if present.
 * Cedar emits a few distinct error templates depending on where the token
 * appears in the grammar; this matches the ones common typos produce.
 */
function extractOffendingToken(message: string): string | null {
  const patterns: RegExp[] = [
    /unexpected token `([^`]+)`/,                          // operator / keyword in expressions
    /invalid variable in the policy scope: (\S+)/,         // mis-typed principal / action / resource
    /invalid policy effect: (\S+)/,                        // mis-typed permit / forbid
  ];
  for (const re of patterns) {
    const m = message.match(re);
    if (m) return m[1]!;
  }
  return null;
}

/** Suggest a hint string for a known typo, or null if none applies. */
function typoHint(message: string): string | null {
  const token = extractOffendingToken(message);
  if (!token) return null;
  const suggestion = TYPO_HINTS[token];
  return suggestion ? `Did you mean '${suggestion}'?` : null;
}

/** Best-effort source location: prefer error's own sourceLocations[0]; null if none. */
function locationFor(err: DetailedError, source: string): { line: number; column: number } | null {
  const loc = err.sourceLocations?.[0];
  if (!loc || typeof loc.start !== "number") return null;
  return offsetToLineCol(source, loc.start);
}

/** Parser-only validation. Used by mode="syntax_only" and by mode="auto" when no schema is resolvable. */
function parseOnlyResult(policies: string): ValidateResult {
  const parseAnswer = checkParsePolicySet({ staticPolicies: policies });
  if (parseAnswer.type === "failure") {
    return {
      valid: false,
      errors: parseAnswer.errors.map((e) => {
        const loc = locationFor(e, policies);
        const hint = typoHint(e.message) ?? e.help ?? null;
        const base: ValidateError = {
          policy_id: "",
          message: e.message,
          hint,
        };
        if (loc) {
          base.line = loc.line;
          base.column = loc.column;
        }
        return base;
      }),
      warnings: [],
      policy_count: countPolicies(policies),
      validation_mode: "syntax_only",
    };
  }
  return {
    valid: true,
    errors: [],
    warnings: [],
    policy_count: countPolicies(policies),
    validation_mode: "syntax_only",
  };
}

export async function handleValidate(input: ValidateInput): Promise<ValidateResult> {
  const mode = input.validation_mode ?? "auto";

  // 11c: explicit syntax_only short-circuits every schema path. The caller
  // said "I have no schema" or "I want a parse-only check"; we honor that
  // even when an inline schema is present and even when a workspace store
  // is loaded.
  if (mode === "syntax_only") {
    return parseOnlyResult(input.policies);
  }

  // 10d workspace auto-discovery. When the caller supplies no schema, consult
  // the StoreManager. Single-store deployments pull the schema implicitly so
  // the validate flow upgrades from syntax-only to syntax_and_schema without
  // forcing the user to paste schema text. Multi-store deployments require
  // an explicit `store` to disambiguate; surface an actionable error rather
  // than guessing which store is intended.
  let schemaText = input.schema;
  let schemaFrom: string | undefined;
  if (schemaText === undefined) {
    if (input.store) {
      try {
        schemaText = storeManager.readSchema(input.store);
        schemaFrom = input.store;
      } catch (e) {
        return {
          valid: false,
          errors: [{
            policy_id: "",
            message: e instanceof Error ? e.message : String(e),
            hint: null,
          }],
          warnings: [],
          policy_count: countPolicies(input.policies),
          validation_mode: mode === "syntax_and_schema" ? "syntax_and_schema" : "syntax_only",
        };
      }
    } else {
      const def = storeManager.getDefaultStore();
      if (def.kind === "single") {
        try {
          schemaText = storeManager.readSchema(def.store.name);
          schemaFrom = def.store.name;
        } catch {
          // Store exists but no schema file; fall through to syntax-only mode.
        }
      } else if (def.kind === "ambiguous") {
        return {
          valid: false,
          errors: [{
            policy_id: "",
            message: `Multiple stores are loaded (${def.names.join(", ")}). Pass store: "<name>" to choose.`,
            hint: null,
          }],
          warnings: [],
          policy_count: countPolicies(input.policies),
          validation_mode: mode === "syntax_and_schema" ? "syntax_and_schema" : "syntax_only",
        };
      }
    }
  }

  // 11c: explicit syntax_and_schema requires a schema. After both inline and
  // auto-discovery paths, if there is still no schema, the caller asked for a
  // mode we cannot honor. Return a clear error rather than silently dropping
  // to syntax_only (which is exactly the Round 4 Scenario I friction).
  if (mode === "syntax_and_schema" && schemaText === undefined) {
    return {
      valid: false,
      errors: [{
        policy_id: "",
        message: 'validation_mode "syntax_and_schema" requires a schema, but none was provided and none could be auto-discovered. Pass schema, schema_ref, or store, or use validation_mode "auto" / "syntax_only".',
        hint: null,
      }],
      warnings: [],
      policy_count: countPolicies(input.policies),
      validation_mode: "syntax_and_schema",
    };
  }

  // Syntax-only mode: no schema supplied (mode === "auto" with no resolvable
  // schema). Run the parser alone so the caller can sanity-check a snippet
  // without having to construct a schema first. Maps any parse failure to
  // the same ValidateError shape the full-validate path uses, so downstream
  // consumers do not need a separate branch.
  if (schemaText === undefined) {
    return parseOnlyResult(input.policies);
  }

  const schema = parseSchema(schemaText);

  // per spike-report-wasm-api.md §2: type field is WASM call health, not policy validity.
  // Check validationErrors.length for actual validity.
  const answer = validate({
    schema,
    policies: { staticPolicies: input.policies },
  });

  const autoDiscovered = schemaFrom ? { schema_from: schemaFrom } : undefined;

  if (answer.type === "failure") {
    return {
      valid: false,
      errors: answer.errors.map((e) => {
        const loc = locationFor(e, input.policies);
        const hint = typoHint(e.message) ?? e.help ?? null;
        const base: ValidateError = {
          policy_id: "",
          message: e.message,
          hint,
        };
        if (loc) {
          base.line = loc.line;
          base.column = loc.column;
        }
        return base;
      }),
      warnings: [],
      policy_count: countPolicies(input.policies),
      validation_mode: "syntax_and_schema",
      ...(autoDiscovered ? { auto_discovered: autoDiscovered } : {}),
    };
  }

  const errors: ValidateError[] = answer.validationErrors.map((e) => {
    const loc = locationFor(e.error, input.policies);
    const base: ValidateError = {
      policy_id: e.policyId,
      message: e.error.message,
      hint: typoHint(e.error.message) ?? e.error.help ?? null,
    };
    if (loc) {
      base.line = loc.line;
      base.column = loc.column;
    }
    return base;
  });

  const warnings: ValidateError[] = answer.validationWarnings.map((e) => {
    const loc = locationFor(e.error, input.policies);
    const base: ValidateError = {
      policy_id: e.policyId,
      message: e.error.message,
      hint: typoHint(e.error.message) ?? e.error.help ?? null,
    };
    if (loc) {
      base.line = loc.line;
      base.column = loc.column;
    }
    return base;
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    policy_count: countPolicies(input.policies),
    validation_mode: "syntax_and_schema",
    ...(autoDiscovered ? { auto_discovered: autoDiscovered } : {}),
  };
}

// ─── 10d workspace auto-discovery wrapper ────────────────────────────────────

/**
 * Inputs accepted by the MCP-level validate entry point. Wider than
 * `ValidateInput` because it also accepts the `_ref` shapes the MCP layer
 * resolves before reaching `handleValidate`.
 */
export interface ValidateMcpInput {
  policies?: string;
  policy_ref?: string;
  schema?: string;
  schema_ref?: string;
  store?: string;
  validation_mode?: "auto" | "syntax_only" | "syntax_and_schema";
}

/**
 * 10d workspace auto-discovery wrapper for `cedar_validate`. Resolves the
 * schema from a loaded MCP root when neither `schema` nor `schema_ref` was
 * supplied. Single-store deployments upgrade to syntax_and_schema mode;
 * multi-store deployments require an explicit `store` parameter and return
 * an ambiguity error otherwise.
 */
export async function handleValidateMcp(
  input: ValidateMcpInput,
  resolveRef: (uri: string) => { content: string } | { error: string },
): Promise<{ result: ValidateResult } | { error: string }> {
  let policies = input.policies;
  if (!policies && input.policy_ref) {
    const resolved = resolveRef(input.policy_ref);
    if ("error" in resolved) return { error: resolved.error };
    policies = resolved.content;
  }
  if (!policies) return { error: "Either policies or policy_ref is required" };

  const mode = input.validation_mode ?? "auto";

  // 11c: explicit syntax_only short-circuits all schema work at the wrapper
  // level too. The user said parser-only; don't read schema_ref off disk,
  // don't auto-discover, don't error on a missing schema. Pass straight to
  // handleValidate which knows to run parseOnlyResult.
  if (mode === "syntax_only") {
    const result = await handleValidate({ policies, validation_mode: "syntax_only" });
    return { result };
  }

  let schema = input.schema;
  if (!schema && input.schema_ref) {
    const resolved = resolveRef(input.schema_ref);
    if ("error" in resolved) return { error: resolved.error };
    schema = resolved.content;
  }

  let autoSchemaFrom: string | undefined;
  if (!schema && !input.schema_ref) {
    if (input.store) {
      try {
        schema = storeManager.readSchema(input.store);
        autoSchemaFrom = input.store;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      const def = storeManager.getDefaultStore();
      if (def.kind === "single") {
        try {
          schema = storeManager.readSchema(def.store.name);
          autoSchemaFrom = def.store.name;
        } catch {
          // Store has no schema file; validate stays in syntax-only mode (auto)
          // or errors out below in syntax_and_schema mode.
        }
      } else if (def.kind === "ambiguous") {
        return { error: `Multiple stores are loaded (${def.names.join(", ")}). Pass store: "<name>" to choose.` };
      }
    }
  }

  const result = await handleValidate({ policies, schema, validation_mode: mode });
  if (autoSchemaFrom) {
    result.auto_discovered = { schema_from: autoSchemaFrom };
  }
  return { result };
}
