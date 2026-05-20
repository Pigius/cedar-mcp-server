import { validate, checkParsePolicySet, policySetTextToParts } from "@cedar-policy/cedar-wasm/nodejs";
import type { Schema } from "@cedar-policy/cedar-wasm/nodejs";

export interface ValidateInput {
  policies: string;
  schema: string;
}

export interface ValidateError {
  policy_id: string;
  message: string;
  hint: string | null;
}

export interface ValidateResult {
  valid: boolean;
  errors: ValidateError[];
  warnings: ValidateError[];
  policy_count: number;
}

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
      errors: answer.errors.map((e) => ({
        policy_id: "",
        message: e.message,
        hint: null,
      })),
      warnings: [],
      policy_count: countPolicies(input.policies),
    };
  }

  const errors: ValidateError[] = answer.validationErrors.map((e) => ({
    policy_id: e.policyId,
    message: e.error.message,
    hint: e.error.help ?? null,
  }));

  const warnings: ValidateError[] = answer.validationWarnings.map((e) => ({
    policy_id: e.policyId,
    message: e.error.message,
    hint: e.error.help ?? null,
  }));

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    policy_count: countPolicies(input.policies),
  };
}
