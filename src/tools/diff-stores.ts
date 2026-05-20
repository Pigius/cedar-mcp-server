import { isAuthorized } from "@cedar-policy/cedar-wasm/nodejs";
import type { StoreManager } from "../resources/store-manager.js";
import { handleCheckChange } from "./check-change.js";
import { normalizePrincipalRef } from "../utils/format-detector.js";
import type { Entities } from "@cedar-policy/cedar-wasm/nodejs";

export interface DiffStoresInput {
  blue: string;
  green: string;
  behavioral_test_requests?: string;
}

export interface PolicyChangeInfo {
  policy_id: string;
  can_update_in_place: boolean;
  changes: Array<{ field: string; in_place_allowed: boolean; reason: string }>;
  recommendation: string;
}

export interface BehavioralDriftEntry {
  principal: string;
  action: string;
  resource: string;
  blue_decision: "Allow" | "Deny";
  green_decision: "Allow" | "Deny";
  drifted: boolean;
}

export interface DiffStoresResult {
  blue: string;
  green: string;
  policies_added: Array<{ policy_id: string; content: string }>;
  policies_removed: Array<{ policy_id: string; content: string }>;
  policies_modified: PolicyChangeInfo[];
  schema_changed: boolean;
  schema_diff_note?: string;
  behavioral_diff?: BehavioralDriftEntry[];
  summary: string;
  error?: string;
}

export async function handleDiffStores(
  input: DiffStoresInput,
  manager: StoreManager
): Promise<DiffStoresResult> {
  // Validate stores exist
  try {
    manager.requireStore(input.blue);
  } catch (e) {
    return errorResult(input.blue, input.green, e instanceof Error ? e.message : String(e));
  }
  try {
    manager.requireStore(input.green);
  } catch (e) {
    return errorResult(input.blue, input.green, e instanceof Error ? e.message : String(e));
  }

  const bluePolicies = new Map<string, string>();
  const greenPolicies = new Map<string, string>();

  for (const id of manager.listPolicies(input.blue)) {
    bluePolicies.set(id, manager.readPolicy(input.blue, id));
  }
  for (const id of manager.listPolicies(input.green)) {
    greenPolicies.set(id, manager.readPolicy(input.green, id));
  }

  // Structural diff
  const policies_added: DiffStoresResult["policies_added"] = [];
  const policies_removed: DiffStoresResult["policies_removed"] = [];
  const policies_modified: PolicyChangeInfo[] = [];

  for (const [id, content] of greenPolicies) {
    if (!bluePolicies.has(id)) {
      policies_added.push({ policy_id: id, content });
    }
  }

  for (const [id, content] of bluePolicies) {
    if (!greenPolicies.has(id)) {
      policies_removed.push({ policy_id: id, content });
    } else {
      const blueContent = content;
      const greenContent = greenPolicies.get(id)!;
      if (blueContent.trim() !== greenContent.trim()) {
        // Reuse check-change logic for AVP immutability classification
        const changeResult = await handleCheckChange({
          old_policy: blueContent,
          new_policy: greenContent,
        });
        if (changeResult.error) {
          // Parse error on one or both sides — report as modified with error context
          policies_modified.push({
            policy_id: id,
            can_update_in_place: false,
            changes: [],
            recommendation: `Could not diff policy "${id}": ${changeResult.error}`,
          });
        } else if (changeResult.changes.length > 0) {
          policies_modified.push({
            policy_id: id,
            can_update_in_place: changeResult.can_update_in_place,
            changes: changeResult.changes.map((c) => ({
              field: c.field,
              in_place_allowed: c.in_place_allowed,
              reason: c.reason,
            })),
            recommendation: changeResult.recommendation,
          });
        }
        // If changes.length === 0 and no error: policies differ in text but not semantically
        // (formatting change). Treat as unchanged — no entry in policies_modified.
      }
    }
  }

  // Schema diff
  let schema_changed = false;
  let schema_diff_note: string | undefined;
  try {
    const blueSchema = manager.readSchema(input.blue).trim();
    const greenSchema = manager.readSchema(input.green).trim();
    schema_changed = blueSchema !== greenSchema;
    if (schema_changed) {
      schema_diff_note = "Schema content differs between blue and green stores. Review schema changes carefully — attribute additions may be safe, type changes or removals can break existing policies.";
    }
  } catch (e) {
    schema_diff_note = `Schema comparison failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Behavioral diff (optional)
  let behavioral_diff: BehavioralDriftEntry[] | undefined;
  if (input.behavioral_test_requests) {
    behavioral_diff = await runBehavioralDiff(
      input.blue,
      input.green,
      input.behavioral_test_requests,
      manager
    );
  }

  // Summary
  const totalChanges =
    policies_added.length + policies_removed.length + policies_modified.length;
  const requiresRecreate = policies_modified.filter((p) => !p.can_update_in_place).length;
  const driftCount = behavioral_diff?.filter((d) => d.drifted).length ?? 0;

  let summary: string;
  if (totalChanges === 0 && !schema_changed) {
    summary = "No changes detected between blue and green stores.";
  } else {
    const parts: string[] = [];
    if (policies_added.length) parts.push(`${policies_added.length} added`);
    if (policies_removed.length) parts.push(`${policies_removed.length} removed`);
    if (policies_modified.length) {
      parts.push(`${policies_modified.length} modified`);
      if (requiresRecreate) parts.push(`(${requiresRecreate} require delete-recreate in AVP)`);
    }
    if (schema_changed) parts.push("schema changed");
    if (driftCount) parts.push(`${driftCount} authorization decision(s) would change`);
    summary = `Policy diff: ${parts.join(", ")}.`;
  }

  return {
    blue: input.blue,
    green: input.green,
    policies_added,
    policies_removed,
    policies_modified,
    schema_changed,
    ...(schema_diff_note ? { schema_diff_note } : {}),
    ...(behavioral_diff !== undefined ? { behavioral_diff } : {}),
    summary,
  };
}

async function runBehavioralDiff(
  blue: string,
  green: string,
  requestsJson: string,
  manager: StoreManager
): Promise<BehavioralDriftEntry[]> {
  let requests: Array<{
    principal: string | object;
    action: string | object;
    resource: string | object;
    entities: string;
    context?: string;
  }>;
  try {
    requests = JSON.parse(requestsJson);
    if (!Array.isArray(requests)) return [{ principal: "", action: "", resource: "", blue_decision: "Deny", green_decision: "Deny", drifted: false }];
  } catch {
    return [];
  }

  const bluePolicies = manager.readAllPolicies(blue);
  const greenPolicies = manager.readAllPolicies(green);

  const entries: BehavioralDriftEntry[] = [];

  for (const req of requests) {
    const principalRef = normalizePrincipalRef(req.principal);
    const actionRef = normalizePrincipalRef(req.action);
    const resourceRef = normalizePrincipalRef(req.resource);

    if ("error" in principalRef || "error" in actionRef || "error" in resourceRef) continue;

    let entities: Entities;
    try {
      entities = JSON.parse(req.entities);
    } catch {
      continue;
    }

    const context = {};
    const callBase = { principal: principalRef, action: actionRef, resource: resourceRef, context, entities };

    const blueAnswer = isAuthorized({ ...callBase, policies: { staticPolicies: bluePolicies } });
    const greenAnswer = isAuthorized({ ...callBase, policies: { staticPolicies: greenPolicies } });

    const blueDecision: "Allow" | "Deny" =
      blueAnswer.type === "success" && blueAnswer.response.decision === "allow" ? "Allow" : "Deny";
    const greenDecision: "Allow" | "Deny" =
      greenAnswer.type === "success" && greenAnswer.response.decision === "allow" ? "Allow" : "Deny";

    entries.push({
      principal: typeof req.principal === "string" ? req.principal : JSON.stringify(req.principal),
      action: typeof req.action === "string" ? req.action : JSON.stringify(req.action),
      resource: typeof req.resource === "string" ? req.resource : JSON.stringify(req.resource),
      blue_decision: blueDecision,
      green_decision: greenDecision,
      drifted: blueDecision !== greenDecision,
    });
  }

  return entries;
}

function errorResult(blue: string, green: string, error: string): DiffStoresResult {
  return {
    blue,
    green,
    policies_added: [],
    policies_removed: [],
    policies_modified: [],
    schema_changed: false,
    summary: "",
    error,
  };
}

