import { templateToJson, validate } from "@cedar-policy/cedar-wasm/nodejs";
import type { PolicyJson } from "@cedar-policy/cedar-wasm/nodejs";

export interface ValidateTemplateInput {
  template: string;
  schema: string;
}

export interface ValidateTemplateResult {
  valid: boolean;
  errors: Array<{ message: string; help?: string }>;
  warnings: Array<{ message: string }>;
  slots_detected: string[];
  error?: string;
}

function detectSlots(json: PolicyJson): string[] {
  const slots: string[] = [];
  const p = json.principal as Record<string, unknown>;
  const r = json.resource as Record<string, unknown>;
  if (p?.slot === "?principal") slots.push("?principal");
  if (r?.slot === "?resource") slots.push("?resource");
  return slots;
}

export async function handleValidateTemplate(input: ValidateTemplateInput): Promise<ValidateTemplateResult> {
  if (!input.schema?.trim()) {
    return { valid: false, errors: [], warnings: [], slots_detected: [], error: "schema is required" };
  }

  // Parse the template
  const parseResult = templateToJson(input.template);
  if (parseResult.type === "failure") {
    return {
      valid: false,
      errors: parseResult.errors.map(e => ({ message: e.message })),
      warnings: [],
      slots_detected: [],
    };
  }

  const slots_detected = detectSlots(parseResult.json as PolicyJson);

  // Validate against schema using the JSON policy struct format with templates key
  const templateId = "t0";
  let validateResult: ReturnType<typeof validate>;
  try {
    validateResult = validate({ schema: input.schema, policies: { staticPolicies: {}, templates: { [templateId]: parseResult.json } } });
  } catch (e) {
    return { valid: false, errors: [{ message: e instanceof Error ? e.message : String(e) }], warnings: [], slots_detected };
  }

  if (validateResult.type === "failure") {
    return {
      valid: false,
      errors: validateResult.errors.map(e => ({ message: e.message, help: e.help ?? undefined })),
      warnings: [],
      slots_detected,
    };
  }

  return {
    valid: validateResult.validationErrors.length === 0,
    errors: validateResult.validationErrors.map(e => ({ message: e.error.message, help: e.error.help ?? undefined })),
    warnings: validateResult.validationWarnings.map(w => ({ message: w.error.message })),
    slots_detected,
  };
}
