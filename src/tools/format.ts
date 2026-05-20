import { formatPolicies } from "@cedar-policy/cedar-wasm/nodejs";

export interface FormatInput {
  policies: string;
  line_width?: number;
  indent_width?: number;
}

export interface FormatResult {
  formatted: string | null;
  error: string | null;
}

export async function handleFormat(input: FormatInput): Promise<FormatResult> {
  // per spike-report-wasm-api.md §3: formatPolicies takes FormattingCall object, not raw string
  const answer = formatPolicies({
    policyText: input.policies,
    ...(input.line_width !== undefined ? { lineWidth: input.line_width } : {}),
    ...(input.indent_width !== undefined ? { indentWidth: input.indent_width } : {}),
  });

  if (answer.type === "failure") {
    return {
      formatted: null,
      error: answer.errors.map((e) => e.message).join("; "),
    };
  }

  return {
    formatted: answer.formatted_policy,
    error: null,
  };
}
