/**
 * Builds deterministic context from a policy store for cedar_advise sampling prompts.
 * No LLM cost — pure AST walking and schema parsing.
 */

import { policyToJson, policySetTextToParts } from "@cedar-policy/cedar-wasm/nodejs";
import { storeManager, StoreManager } from "../../resources/store-manager.js";
import { classifyPolicy } from "./cedar-patterns.js";

export interface PolicyInventoryEntry {
  policy_id: string;
  pattern: string;
  pattern_confidence: string;
  summary: string;
  policy_text: string;
}

export interface StoreContext {
  store_name: string;
  schema_text: string;
  policy_inventory: PolicyInventoryEntry[];
  policy_count: number;
}

/**
 * Build structured context from a named policy store.
 * Returns null if the store doesn't exist or has no content.
 */
export function buildStoreContext(storeName: string, manager: StoreManager = storeManager): StoreContext | null {
  try {
    const schema = manager.readSchema(storeName);
    const inventory: PolicyInventoryEntry[] = [];
    const policyIds = manager.listPolicies(storeName);

    for (const id of policyIds) {
      const content = manager.readPolicy(storeName, id);
      try {
        const parseResult = policyToJson(content.trim());
        if (parseResult.type === "success") {
          const classification = classifyPolicy(parseResult.json);
          inventory.push({
            policy_id: id,
            pattern: classification.pattern,
            pattern_confidence: classification.confidence,
            summary: buildPolicySummary(id, parseResult.json.effect, classification.evidence),
            policy_text: content.trim(),
          });
        } else {
          inventory.push({
            policy_id: id,
            pattern: "unknown",
            pattern_confidence: "low",
            summary: `${id}: parse failed — ${parseResult.errors[0]?.message ?? "unknown error"}`,
            policy_text: content.trim(),
          });
        }
      } catch {
        inventory.push({
          policy_id: id,
          pattern: "unknown",
          pattern_confidence: "low",
          summary: `${id}: could not analyze`,
          policy_text: content.trim(),
        });
      }
    }

    return {
      store_name: storeName,
      schema_text: schema,
      policy_inventory: inventory,
      policy_count: policyIds.length,
    };
  } catch {
    return null;
  }
}

/** Resolve a store_ref to a store name. Accepts "mystore", "cedar://policies/mystore", etc. */
export function resolveStoreRef(storeRef: string): string {
  if (storeRef.startsWith("cedar://")) {
    const match = storeRef.match(/cedar:\/\/(?:policies|schema)\/([^/]+)/);
    return match?.[1] ?? storeRef;
  }
  return storeRef;
}

function buildPolicySummary(id: string, effect: string, evidence: string): string {
  return `${id} (${effect}, ${evidence})`;
}

/** Format store context as a prompt section. */
export function formatContextForPrompt(ctx: StoreContext): string {
  const lines: string[] = [
    `Store: "${ctx.store_name}" (${ctx.policy_count} policies)`,
    "",
    "Schema:",
    ctx.schema_text,
    "",
    "Existing policies:",
  ];

  for (const p of ctx.policy_inventory) {
    lines.push(`  - ${p.policy_id}: pattern=${p.pattern} (${p.pattern_confidence} confidence) — ${p.summary}`);
    lines.push(`    text: ${p.policy_text}`);
  }

  return lines.join("\n");
}
