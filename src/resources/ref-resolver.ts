/**
 * Resolves cedar:// resource references to their content.
 * Allows tools to accept policy_ref / schema_ref as alternatives to inline text.
 *
 * URI patterns:
 *   cedar://policies/{store}                → all policies in store concatenated
 *   cedar://policies/{store}/{id}           → single policy content
 *   cedar://schema/{store}                  → schema content
 *   cedar://templates/{store}               → template ID list as JSON array
 *   cedar://templates/{store}/{template_id} → single template content
 *   cedar://template-links/{store}          → link ID list as JSON array
 *   cedar://template-links/{store}/{link_id}→ single template-link JSON content
 *   cedar://entities/{store}                → merged entity arrays as JSON
 *   cedar://entities/{store}/{file_id}      → single entity file content
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

  // cedar://templates/{store}/{template_id}
  const singleTemplateMatch = path.match(/^templates\/([^/]+)\/([^/]+)$/);
  if (singleTemplateMatch) {
    const storeName = singleTemplateMatch[1]!;
    const templateId = singleTemplateMatch[2]!;
    try {
      return { content: storeManager.readTemplate(storeName, templateId), resolved_from: ref };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // cedar://templates/{store}  — template ID list as JSON
  const allTemplatesMatch = path.match(/^templates\/([^/]+)$/);
  if (allTemplatesMatch) {
    const storeName = allTemplatesMatch[1]!;
    try {
      return { content: JSON.stringify(storeManager.listTemplates(storeName)), resolved_from: ref };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // cedar://template-links/{store}/{link_id}
  const singleLinkMatch = path.match(/^template-links\/([^/]+)\/([^/]+)$/);
  if (singleLinkMatch) {
    const storeName = singleLinkMatch[1]!;
    const linkId = singleLinkMatch[2]!;
    try {
      const link = storeManager.readTemplateLink(storeName, linkId);
      return { content: JSON.stringify(link), resolved_from: ref };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // cedar://template-links/{store}  — link ID list as JSON
  const allLinksMatch = path.match(/^template-links\/([^/]+)$/);
  if (allLinksMatch) {
    const storeName = allLinksMatch[1]!;
    try {
      return { content: JSON.stringify(storeManager.listTemplateLinks(storeName)), resolved_from: ref };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // cedar://entities/{store}/{file_id}
  const singleEntityMatch = path.match(/^entities\/([^/]+)\/([^/]+)$/);
  if (singleEntityMatch) {
    const storeName = singleEntityMatch[1]!;
    const fileId = singleEntityMatch[2]!;
    try {
      return { content: storeManager.readEntities(storeName, fileId), resolved_from: ref };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // cedar://entities/{store}  — merged entity arrays as JSON
  const allEntitiesMatch = path.match(/^entities\/([^/]+)$/);
  if (allEntitiesMatch) {
    const storeName = allEntitiesMatch[1]!;
    try {
      return { content: storeManager.readAllEntities(storeName), resolved_from: ref };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { error: `Unrecognized cedar:// URI pattern: "${ref}". Supported: cedar://policies/{store}[/{id}], cedar://schema/{store}, cedar://templates/{store}[/{id}], cedar://template-links/{store}[/{id}], cedar://entities/{store}[/{id}]` };
}
