import { validate, checkParsePolicySet, policySetTextToParts } from "@cedar-policy/cedar-wasm/nodejs";
import type { Schema, DetailedError } from "@cedar-policy/cedar-wasm/nodejs";

export interface ValidateInput {
  policies: string;
  schema: string;
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

export async function handleValidate(input: ValidateInput): Promise<ValidateResult> {
  const schema = parseSchema(input.schema);

  // per spike-report-wasm-api.md §2: type field is WASM call health, not policy validity.
  // Check validationErrors.length for actual validity.
  const answer = validate({
    schema,
    policies: { staticPolicies: input.policies },
  });

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
  };
}
