import { checkParseSchema } from "@cedar-policy/cedar-wasm/nodejs";
import type { Schema } from "@cedar-policy/cedar-wasm/nodejs";

export interface ValidateSchemaInput {
  schema: string;
}

export interface SchemaParseError {
  message: string;
  source_location?: { start: number; end: number; label?: string | null };
}

export interface ValidateSchemaResult {
  valid: boolean;
  format: "json" | "cedarschema";
  namespaces: string[];
  entity_type_count: number;
  action_count: number;
  common_type_count: number;
  errors: SchemaParseError[];
}

function parseSchemaInput(schemaStr: string): { schema: Schema; format: "json" | "cedarschema" } {
  try {
    return { schema: JSON.parse(schemaStr), format: "json" };
  } catch {
    return { schema: schemaStr, format: "cedarschema" };
  }
}

interface JsonSchemaShape {
  [namespace: string]: {
    entityTypes?: Record<string, unknown>;
    actions?: Record<string, unknown>;
    commonTypes?: Record<string, unknown>;
  };
}

function summarizeJsonSchema(json: unknown): {
  namespaces: string[];
  entity_type_count: number;
  action_count: number;
  common_type_count: number;
} {
  const empty = { namespaces: [], entity_type_count: 0, action_count: 0, common_type_count: 0 };
  if (!json || typeof json !== "object") return empty;
  const shape = json as JsonSchemaShape;

  const namespaces = Object.keys(shape);
  let entity_type_count = 0;
  let action_count = 0;
  let common_type_count = 0;

  for (const ns of namespaces) {
    const block = shape[ns];
    if (block.entityTypes) entity_type_count += Object.keys(block.entityTypes).length;
    if (block.actions) action_count += Object.keys(block.actions).length;
    if (block.commonTypes) common_type_count += Object.keys(block.commonTypes).length;
  }

  return { namespaces, entity_type_count, action_count, common_type_count };
}

export async function handleValidateSchema(
  input: ValidateSchemaInput
): Promise<ValidateSchemaResult> {
  if (!input.schema || input.schema.trim() === "") {
    return {
      valid: false,
      format: "cedarschema",
      namespaces: [],
      entity_type_count: 0,
      action_count: 0,
      common_type_count: 0,
      errors: [{ message: "Schema input is empty" }],
    };
  }

  const { schema, format } = parseSchemaInput(input.schema);
  const answer = checkParseSchema(schema);

  if (answer.type === "failure") {
    return {
      valid: false,
      format,
      namespaces: [],
      entity_type_count: 0,
      action_count: 0,
      common_type_count: 0,
      errors: answer.errors.map((e) => ({
        message: e.message,
        ...(e.sourceLocations && e.sourceLocations.length > 0
          ? { source_location: { start: e.sourceLocations[0].start, end: e.sourceLocations[0].end, label: e.sourceLocations[0].label } }
          : {}),
      })),
    };
  }

  if (format === "json") {
    const summary = summarizeJsonSchema(schema);
    return { valid: true, format, ...summary, errors: [] };
  }

  // For cedarschema text, derive summary by translating to JSON form.
  // schemaToJsonWithResolvedTypes only accepts string input (per spike-report §"Schema standalone ops spike").
  if (typeof schema === "string") {
    try {
      const { schemaToJsonWithResolvedTypes } = await import("@cedar-policy/cedar-wasm/nodejs");
      const jsonAnswer = schemaToJsonWithResolvedTypes(schema);
      if (jsonAnswer.type === "success") {
        const summary = summarizeJsonSchema(jsonAnswer.json);
        return { valid: true, format, ...summary, errors: [] };
      }
    } catch {
      // fall through to summary-less success
    }
  }

  return {
    valid: true,
    format,
    namespaces: [],
    entity_type_count: 0,
    action_count: 0,
    common_type_count: 0,
    errors: [],
  };
}
