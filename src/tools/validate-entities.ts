import { checkParseEntities } from "@cedar-policy/cedar-wasm/nodejs";
import type { Schema } from "@cedar-policy/cedar-wasm/nodejs";

export interface ValidateEntitiesInput {
  entities: string;
  schema?: string;
}

export type EntityErrorKind =
  | "unknown_type"
  | "missing_required_attribute"
  | "type_mismatch"
  | "unknown_attribute"
  | "orphan_parent"
  | "parse_error"
  | "other";

export interface EntityError {
  entity_uid: string;
  error_kind: EntityErrorKind;
  message: string;
  attribute?: string;
}

export interface ValidateEntitiesResult {
  valid: boolean;
  entity_count: number;
  errors: EntityError[];
}

function parseSchema(schemaStr: string | undefined): Schema | undefined {
  if (!schemaStr) return undefined;
  try {
    return JSON.parse(schemaStr);
  } catch {
    return schemaStr;
  }
}

// Each regex captures: 1) entity_uid (everything between backticks), 2) attribute name when present.
const RE_TYPE_MISMATCH = /in attribute `([^`]+)` on `([^`]+)`, type mismatch/;
const RE_MISSING_REQUIRED = /expected entity `([^`]+)` to have attribute `([^`]+)`, but it does not/;
const RE_UNKNOWN_TYPE = /entity `([^`]+)` has type `[^`]+` which is not declared in the schema/;
const RE_UNKNOWN_ATTR = /attribute `([^`]+)` on `([^`]+)` should not exist according to the schema/;

function classifyError(message: string): EntityError {
  let m: RegExpMatchArray | null;

  if ((m = message.match(RE_TYPE_MISMATCH))) {
    return { entity_uid: m[2], error_kind: "type_mismatch", attribute: m[1], message };
  }
  if ((m = message.match(RE_MISSING_REQUIRED))) {
    return {
      entity_uid: m[1],
      error_kind: "missing_required_attribute",
      attribute: m[2],
      message,
    };
  }
  if ((m = message.match(RE_UNKNOWN_TYPE))) {
    return { entity_uid: m[1], error_kind: "unknown_type", message };
  }
  if ((m = message.match(RE_UNKNOWN_ATTR))) {
    return { entity_uid: m[2], error_kind: "unknown_attribute", attribute: m[1], message };
  }

  return { entity_uid: "", error_kind: "other", message };
}

export async function handleValidateEntities(
  input: ValidateEntitiesInput
): Promise<ValidateEntitiesResult> {
  // 1. Parse entities JSON
  let entities: unknown;
  try {
    entities = JSON.parse(input.entities);
  } catch (e) {
    return {
      valid: false,
      entity_count: 0,
      errors: [
        {
          entity_uid: "",
          error_kind: "parse_error",
          message: `Entities JSON failed to parse: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }

  if (!Array.isArray(entities)) {
    return {
      valid: false,
      entity_count: 0,
      errors: [
        {
          entity_uid: "",
          error_kind: "parse_error",
          message: "Entities must be a JSON array of entity objects",
        },
      ],
    };
  }

  const entity_count = entities.length;
  const schema = parseSchema(input.schema);

  const call = schema ? { entities: entities as never, schema } : { entities: entities as never };
  const answer = checkParseEntities(call);

  if (answer.type === "success") {
    return { valid: true, entity_count, errors: [] };
  }

  const errors = answer.errors.map((e) => classifyError(e.message));
  return { valid: false, entity_count, errors };
}
