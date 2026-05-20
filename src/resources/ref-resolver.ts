/**
 * Resolves cedar:// resource references to their content.
 * Allows tools to accept policy_ref / schema_ref as alternatives to inline text.
 *
 * URI patterns:
 *   cedar://policies/{store}           → all policies in store concatenated
 *   cedar://policies/{store}/{id}      → single policy content
 *   cedar://schema/{store}             → schema content
 */

import { storeManager } from "./store-manager.js";

export type RefResolution =
  | { content: string; resolved_from: string }
  | { error: string };

export function resolveRef(ref: string): RefResolution {
  const match = ref.match(/^cedar:\/\/(.+)$/);
  if (!match) return { error: `Invalid cedar:// reference: "${ref}"` };

  const path = match[1]!;

  // cedar://schema/{store}
  const schemaMatch = path.match(/^schema\/([^/]+)$/);
  if (schemaMatch) {
    const storeName = schemaMatch[1]!;
    try {
      return { content: storeManager.readSchema(storeName), resolved_from: ref };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // cedar://policies/{store}/{policy_id}
  const singlePolicyMatch = path.match(/^policies\/([^/]+)\/([^/]+)$/);
  if (singlePolicyMatch) {
    const storeName = singlePolicyMatch[1]!;
    const policyId = singlePolicyMatch[2]!;
    try {
      return { content: storeManager.readPolicy(storeName, policyId), resolved_from: ref };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // cedar://policies/{store}  — all policies concatenated
  const allPoliciesMatch = path.match(/^policies\/([^/]+)$/);
  if (allPoliciesMatch) {
    const storeName = allPoliciesMatch[1]!;
    try {
      return { content: storeManager.readAllPolicies(storeName), resolved_from: ref };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { error: `Unrecognized cedar:// URI pattern: "${ref}". Expected cedar://policies/{store}, cedar://policies/{store}/{id}, or cedar://schema/{store}` };
}
