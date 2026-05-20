/**
 * AVP UpdatePolicy mutability rules — proven from official docs 2026-05-20:
 * https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_UpdatePolicy.html
 *
 * UpdatePolicy only updates STATIC policies. Template-linked → use UpdatePolicyTemplate.
 */

export type AvpUpdateMode = "in_place_via_update_policy" | "requires_delete_recreate" | "new_policy_via_create_policy";

export interface AvpChangeClassification {
  mode: AvpUpdateMode;
  rationale: string;
}

/** Classify which AVP API call a given change type requires. */
export function classifyAvpChange(changeField: string): AvpChangeClassification {
  switch (changeField) {
    case "action":
    case "when_clause":
    case "unless_clause":
    case "policy_name":
      return {
        mode: "in_place_via_update_policy",
        rationale: "AVP UpdatePolicy supports modifying actions, when/unless clauses, and policy name in-place.",
      };
    case "effect":
    case "principal":
    case "resource":
    case "policy_type_conversion":
      return {
        mode: "requires_delete_recreate",
        rationale: "AVP UpdatePolicy cannot change effect, principal scope, resource scope, or convert between static and template-linked policies. Delete the existing policy and create a new one.",
      };
    case "new_policy":
      return {
        mode: "new_policy_via_create_policy",
        rationale: "New policy — use AVP CreatePolicy API.",
      };
    default:
      return {
        mode: "in_place_via_update_policy",
        rationale: "Change type unclassified — assume in-place update is possible but verify.",
      };
  }
}

/** Validation error categories AVP raises — pre-detectable during authoring. */
export const AVP_VALIDATION_ERRORS = [
  { id: "UnrecognizedEntityType", description: "Policy references an entity type not declared in the schema." },
  { id: "UnrecognizedActionId", description: "Policy references an action not declared in the schema." },
  { id: "InvalidActionApplication", description: "Action does not apply to the specified principal and resource types per the schema appliesTo definition." },
  { id: "UnexpectedType", description: "An operand has the wrong type for the operation (e.g. comparing a String to an entity)." },
  { id: "IncompatibleTypes", description: "Types in a Set or if/then/else expression are incompatible." },
  { id: "MissingAttribute", description: "Policy accesses an attribute not declared in the schema. Add the attribute to the schema or use a has guard." },
  { id: "UnsafeOptionalAttributeAccess", description: "Policy accesses an optional attribute without a has guard. This causes Cedar to silently skip the policy for principals/resources missing the attribute." },
  { id: "ImpossiblePolicy", description: "Cedar determined the condition always evaluates to false — the policy can never match any request." },
  { id: "WrongNumberArguments", description: "Extension type function called with wrong number of arguments." },
  { id: "FunctionArgumentValidationError", description: "Argument to an extension type function could not be parsed (e.g. invalid IP address string)." },
] as const;

export type AvpValidationErrorId = typeof AVP_VALIDATION_ERRORS[number]["id"];

/** AVP immutability rules summary — for use in sampling prompts. */
export const AVP_RULES_SUMMARY = `
AVP UpdatePolicy constraints (verified from official API docs):
MUTABLE via UpdatePolicy: action scope, when/unless conditions, policy name.
IMMUTABLE (delete+recreate required): effect (permit↔forbid), principal scope, resource scope, static↔template-linked conversion.
NEW policies: use CreatePolicy API.
Template-linked policies: use UpdatePolicyTemplate, not UpdatePolicy.
`.trim();
