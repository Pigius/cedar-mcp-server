import { policyToJson } from "@cedar-policy/cedar-wasm/nodejs";
import type { PolicyJson } from "@cedar-policy/cedar-wasm/nodejs";

export interface CheckChangeInput {
  old_policy: string;
  new_policy: string;
}

export interface PolicyChange {
  field: "effect" | "principal" | "resource" | "action" | "conditions";
  old_value?: string;
  new_value?: string;
  in_place_allowed: boolean;
  reason: string;
}

export interface CheckChangeResult {
  can_update_in_place: boolean;
  changes: PolicyChange[];
  recommendation: string;
  error?: string;
}

const IN_PLACE_RULES: Record<string, { allowed: boolean; reason: string }> = {
  effect: {
    allowed: false,
    reason: "Changing effect (permit ↔ forbid) requires deleting and recreating the policy.",
  },
  principal: {
    allowed: false,
    reason: "Changing the principal clause requires deleting and recreating the policy.",
  },
  resource: {
    allowed: false,
    reason: "Changing the resource clause requires deleting and recreating the policy.",
  },
  action: {
    allowed: true,
    reason: "Action clause changes can be applied in-place.",
  },
  conditions: {
    allowed: true,
    reason: "Condition clause (when/unless) changes can be applied in-place.",
  },
};

function parsePolicy(text: string): PolicyJson {
  const result = policyToJson(text);
  if (result.type === "failure") {
    throw new Error(result.errors.map((e) => e.message).join("; "));
  }
  return result.json;
}

function stringify(v: unknown): string {
  return JSON.stringify(v);
}

const EMPTY_RESULT: Omit<CheckChangeResult, "error"> = {
  can_update_in_place: false,
  changes: [],
  recommendation: "",
};

export async function handleCheckChange(input: CheckChangeInput): Promise<CheckChangeResult> {
  let oldJson: PolicyJson;
  let newJson: PolicyJson;
  try {
    oldJson = parsePolicy(input.old_policy);
  } catch (e) {
    return { ...EMPTY_RESULT, error: `Failed to parse old_policy: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    newJson = parsePolicy(input.new_policy);
  } catch (e) {
    return { ...EMPTY_RESULT, error: `Failed to parse new_policy: ${e instanceof Error ? e.message : String(e)}` };
  }

  const changes: PolicyChange[] = [];

  // Compare each field. Effect is a string; others are structured objects.
  const fields: Array<keyof typeof IN_PLACE_RULES> = [
    "effect",
    "principal",
    "resource",
    "action",
    "conditions",
  ];

  for (const field of fields) {
    const oldVal = field === "effect" ? oldJson.effect : (oldJson as unknown as Record<string, unknown>)[field];
    const newVal = field === "effect" ? newJson.effect : (newJson as unknown as Record<string, unknown>)[field];

    if (stringify(oldVal) !== stringify(newVal)) {
      const rule = IN_PLACE_RULES[field]!;
      changes.push({
        field: field as PolicyChange["field"],
        old_value: stringify(oldVal),
        new_value: stringify(newVal),
        in_place_allowed: rule.allowed,
        reason: rule.reason,
      });
    }
  }

  const can_update_in_place = changes.every((c) => c.in_place_allowed);

  let recommendation: string;
  if (changes.length === 0) {
    recommendation = "No changes detected.";
  } else if (can_update_in_place) {
    recommendation = "All changes can be applied as an in-place policy update.";
  } else {
    const blocking = changes.filter((c) => !c.in_place_allowed).map((c) => c.field);
    recommendation = `Delete the existing policy and create a new one. The following fields cannot be changed in-place: ${blocking.join(", ")}.`;
  }

  return { can_update_in_place, changes, recommendation };
}
