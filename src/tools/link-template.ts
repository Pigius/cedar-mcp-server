import { templateToJson, policyToText, policyToJson, validate } from "@cedar-policy/cedar-wasm/nodejs";
import type { PolicyJson, DetailedError } from "@cedar-policy/cedar-wasm/nodejs";

export interface LinkTemplateInput {
  template: string;
  principal?: string;
  resource?: string;
  schema?: string;
}

export interface LinkTemplateResult {
  linked_policy?: string;
  slots_bound: Record<string, string>;
  valid?: boolean;
  errors?: Array<{ message: string }>;
  error?: string;
}

interface EntityRef {
  type: string;
  id: string;
}

function parseEntityRef(ref: string): EntityRef | null {
  // Expects: "Namespace::Type::\"id\"" or "Type::\"id\""
  const match = ref.match(/^(.+)::"(.+)"$/);
  if (!match) return null;
  return { type: match[1]!, id: match[2]! };
}

export async function handleLinkTemplate(input: LinkTemplateInput): Promise<LinkTemplateResult> {
  // Parse the template
  const parseResult = templateToJson(input.template);
  if (parseResult.type === "failure") {
    const msg = parseResult.errors.map(e => e.message).join("; ");
    return { slots_bound: {}, error: `Failed to parse template: ${msg}` };
  }

  const json = parseResult.json as unknown as Record<string, unknown>;

  // Determine which slots are present
  const principalSlot = (json.principal as Record<string, unknown>)?.slot === "?principal";
  const resourceSlot = (json.resource as Record<string, unknown>)?.slot === "?resource";

  const slots_bound: Record<string, string> = {};

  // Validate that required slots are provided
  if (principalSlot && !input.principal) {
    return { slots_bound: {}, error: "Template has a ?principal slot but no principal value was provided." };
  }
  if (resourceSlot && !input.resource) {
    return { slots_bound: {}, error: "Template has a ?resource slot but no resource value was provided." };
  }

  // Parse and substitute slots
  const linked = { ...json };

  if (principalSlot && input.principal) {
    const entity = parseEntityRef(input.principal);
    if (!entity) {
      return { slots_bound: {}, error: `Invalid principal entity reference format: "${input.principal}". Expected format: Namespace::Type::"id"` };
    }
    linked.principal = { op: "==", entity };
    slots_bound["?principal"] = input.principal;
  }

  if (resourceSlot && input.resource) {
    const entity = parseEntityRef(input.resource);
    if (!entity) {
      return { slots_bound: {}, error: `Invalid resource entity reference format: "${input.resource}". Expected format: Namespace::Type::"id"` };
    }
    linked.resource = { op: "==", entity };
    slots_bound["?resource"] = input.resource;
  }

  // Convert linked JSON to Cedar text
  const textResult = policyToText(linked as unknown as PolicyJson);
  if (textResult.type === "failure") {
    const msg = (textResult.errors as DetailedError[]).map(e => e.message).join("; ");
    return { slots_bound, error: `Failed to render linked policy: ${msg}` };
  }

  const linked_policy = textResult.text;

  // Optionally validate the linked policy (now a regular policy, not a template) against schema
  if (input.schema) {
    const parsed = policyToJson(linked_policy);
    if (parsed.type === "failure") {
      return { linked_policy, slots_bound, valid: false, errors: parsed.errors.map(e => ({ message: e.message })) };
    }
    let validateResult: ReturnType<typeof validate>;
    try {
      validateResult = validate({ schema: input.schema, policies: { staticPolicies: { p0: parsed.json }, templates: {} } });
    } catch (e) {
      return { linked_policy, slots_bound, valid: false, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
    if (validateResult.type === "failure") {
      return { linked_policy, slots_bound, valid: false, errors: validateResult.errors.map(e => ({ message: e.message })) };
    }
    return {
      linked_policy,
      slots_bound,
      valid: validateResult.validationErrors.length === 0,
      errors: validateResult.validationErrors.map(e => ({ message: e.error.message })),
    };
  }

  return { linked_policy, slots_bound };
}
