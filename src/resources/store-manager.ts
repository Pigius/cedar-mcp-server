/**
 * StoreManager maps MCP root URIs to named Cedar policy stores.
 *
 * Convention for a policy store directory:
 *   <root>/
 *     policies/        ← .cedar files, one per policy
 *     schema.cedarschema  ← Cedar schema text (preferred)
 *     schema.json         ← Cedar JSON schema (fallback)
 *
 * Security: isPathAllowed() checks that any file access stays within a loaded root.
 * The SDK does not enforce roots automatically — every file operation calls this check.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

export interface PolicyStore {
  name: string;
  uri: string;
  path: string;
}

export class StoreManager {
  private stores = new Map<string, PolicyStore>();

  // ─── Store lifecycle ────────────────────────────────────────────────────────

  loadFromRoots(roots: Array<{ uri: string; name?: string }>): void {
    this.stores.clear();
    const usedNames = new Map<string, number>(); // tracks how many times each base name is used

    for (const root of roots) {
      if (!root.uri.startsWith("file://")) {
        console.error(`[cedar-mcp-server] Skipping unsupported root URI scheme: ${root.uri} (only file:// is supported)`);
        continue;
      }
      const rawPath = root.uri.replace(/^file:\/\//, "").replace(/\/$/, "");
      const baseName = root.name ?? basename(rawPath) ?? "default";

      // Disambiguate collisions with a numeric suffix
      const count = usedNames.get(baseName) ?? 0;
      usedNames.set(baseName, count + 1);
      const name = count === 0 ? baseName : `${baseName}-${count + 1}`;

      if (count > 0) {
        console.error(`[cedar-mcp-server] Store name collision: "${baseName}" is used by multiple roots. Renamed to "${name}". Consider giving roots explicit names.`);
      }

      this.stores.set(name, { name, uri: root.uri, path: rawPath });
    }
  }

  listStoreNames(): string[] {
    return [...this.stores.keys()];
  }

  getStore(name: string): PolicyStore | undefined {
    return this.stores.get(name);
  }

  // ─── Policy access ──────────────────────────────────────────────────────────

  listPolicies(storeName: string): string[] {
    const store = this.requireStore(storeName);
    const policiesDir = join(store.path, "policies");
    if (!existsSync(policiesDir)) return [];
    return readdirSync(policiesDir)
      .filter((f) => f.endsWith(".cedar"))
      .map((f) => f.replace(/\.cedar$/, ""))
      .sort();
  }

  readPolicy(storeName: string, policyId: string): string {
    const store = this.requireStore(storeName);
    // Prevent path traversal — policy IDs must be simple filenames with no slashes or dots
    if (!/^[a-zA-Z0-9_-]+$/.test(policyId)) {
      throw new Error(`Invalid policy ID: "${policyId}". Policy IDs must contain only letters, digits, hyphens, and underscores.`);
    }
    const filePath = join(store.path, "policies", `${policyId}.cedar`);
    if (!existsSync(filePath)) {
      throw new Error(`Policy not found: "${policyId}" in store "${storeName}"`);
    }
    return readFileSync(filePath, "utf8");
  }

  readAllPolicies(storeName: string): string {
    const ids = this.listPolicies(storeName);
    return ids.map((id) => this.readPolicy(storeName, id)).join("\n\n");
  }

  // ─── Template access ────────────────────────────────────────────────────────

  listTemplates(storeName: string): string[] {
    const store = this.requireStore(storeName);
    const templatesDir = join(store.path, "templates");
    if (!existsSync(templatesDir)) return [];
    return readdirSync(templatesDir)
      .filter((f) => f.endsWith(".cedar"))
      .map((f) => f.replace(/\.cedar$/, ""))
      .sort();
  }

  readTemplate(storeName: string, templateId: string): string {
    const store = this.requireStore(storeName);
    if (!/^[a-zA-Z0-9_-]+$/.test(templateId)) {
      throw new Error(`Invalid template ID: "${templateId}". Template IDs must contain only letters, digits, hyphens, and underscores.`);
    }
    const filePath = join(store.path, "templates", `${templateId}.cedar`);
    if (!existsSync(filePath)) {
      throw new Error(`Template not found: "${templateId}" in store "${storeName}"`);
    }
    return readFileSync(filePath, "utf8");
  }

  // ─── Template link access ────────────────────────────────────────────────────

  listTemplateLinks(storeName: string): string[] {
    const store = this.requireStore(storeName);
    const linksDir = join(store.path, "template-links");
    if (!existsSync(linksDir)) return [];
    return readdirSync(linksDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  }

  readTemplateLink(storeName: string, linkId: string): { template_id: string; slot_values: Record<string, string> } {
    const store = this.requireStore(storeName);
    if (!/^[a-zA-Z0-9_-]+$/.test(linkId)) {
      throw new Error(`Invalid link ID: "${linkId}". Link IDs must contain only letters, digits, hyphens, and underscores.`);
    }
    const filePath = join(store.path, "template-links", `${linkId}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Template link not found: "${linkId}" in store "${storeName}"`);
    }
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as { template_id: string; slot_values: Record<string, string> };
  }

  // ─── Entities access ────────────────────────────────────────────────────────

  listEntities(storeName: string): string[] {
    const store = this.requireStore(storeName);
    const entitiesDir = join(store.path, "entities");
    if (!existsSync(entitiesDir)) return [];
    return readdirSync(entitiesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  }

  readEntities(storeName: string, entityFileId: string): string {
    const store = this.requireStore(storeName);
    if (!/^[a-zA-Z0-9_-]+$/.test(entityFileId)) {
      throw new Error(`Invalid entity file ID: "${entityFileId}". Entity file IDs must contain only letters, digits, hyphens, and underscores.`);
    }
    const filePath = join(store.path, "entities", `${entityFileId}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Entity file not found: "${entityFileId}" in store "${storeName}"`);
    }
    return readFileSync(filePath, "utf8");
  }

  readAllEntities(storeName: string): string {
    const ids = this.listEntities(storeName);
    const merged: unknown[] = [];
    for (const id of ids) {
      const raw = this.readEntities(storeName, id);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Entity file "${id}" in store "${storeName}" contains invalid JSON.`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`Entity file "${id}" in store "${storeName}" must contain a JSON array at the top level, got ${typeof parsed}.`);
      }
      merged.push(...parsed);
    }
    return JSON.stringify(merged);
  }

  // ─── Schema access ──────────────────────────────────────────────────────────

  readSchema(storeName: string): string {
    const store = this.requireStore(storeName);
    const cedarSchema = join(store.path, "schema.cedarschema");
    if (existsSync(cedarSchema)) return readFileSync(cedarSchema, "utf8");
    const jsonSchema = join(store.path, "schema.json");
    if (existsSync(jsonSchema)) return readFileSync(jsonSchema, "utf8");
    throw new Error(`Schema not found in store "${storeName}". Expected schema.cedarschema or schema.json at ${store.path}`);
  }

  // ─── Security ───────────────────────────────────────────────────────────────

  isPathAllowed(filePath: string): boolean {
    const normalizedRequest = filePath.replace(/\/$/, "");
    for (const store of this.stores.values()) {
      if (normalizedRequest.startsWith(store.path)) return true;
    }
    return false;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  requireStore(name: string): PolicyStore {
    const store = this.stores.get(name);
    if (!store) {
      const available = [...this.stores.keys()].join(", ") || "none";
      const hint = this.stores.size === 0
        ? " No roots are configured. Add MCP roots in your client settings, each pointing at a directory with a policies/ subdirectory and a schema.cedarschema or schema.json file."
        : ` Available stores: ${available}.`;
      throw new Error(`Store not found: "${name}".${hint}`);
    }
    return store;
  }
}

export const storeManager = new StoreManager();
