import {
  policyToJson,
  policyToText,
  schemaToJson,
  schemaToText,
} from "@cedar-policy/cedar-wasm/nodejs";
import type { Schema } from "@cedar-policy/cedar-wasm/nodejs";

export interface TranslateInput {
  input: string;
  type: "policy" | "schema";
  direction: "to_json" | "to_cedar";
}

export interface TranslateResult {
  output: string | null;
  error: string | null;
}

function parseSchemaInput(input: string): Schema {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export async function handleTranslate(input: TranslateInput): Promise<TranslateResult> {
  // per spike-report-wasm-api.md §5-6: function names are policyToJson/policyToText/schemaToJson/schemaToText,
  // not translate_policy/translate_schema as the design doc assumed
  if (input.type === "policy") {
    if (input.direction === "to_json") {
      const answer = policyToJson(input.input);
      if (answer.type === "failure") {
        return { output: null, error: answer.errors.map((e) => e.message).join("; ") };
      }
      return { output: JSON.stringify(answer.json, null, 2), error: null };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.input);
      } catch {
        return { output: null, error: "Input must be a valid JSON policy object for to_cedar direction" };
      }
      const answer = policyToText(parsed as Parameters<typeof policyToText>[0]);
      if (answer.type === "failure") {
        return { output: null, error: answer.errors.map((e) => e.message).join("; ") };
      }
      return { output: answer.text, error: null };
    }
  } else {
    if (input.direction === "to_json") {
      const answer = schemaToJson(parseSchemaInput(input.input));
      if (answer.type === "failure") {
        return { output: null, error: answer.errors.map((e) => e.message).join("; ") };
      }
      return { output: JSON.stringify(answer.json, null, 2), error: null };
    } else {
      const answer = schemaToText(parseSchemaInput(input.input));
      if (answer.type === "failure") {
        return { output: null, error: answer.errors.map((e) => e.message).join("; ") };
      }
      return { output: answer.text, error: null };
    }
  }
}
