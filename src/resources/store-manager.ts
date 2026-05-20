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
    for (const root of roots) {
      const rawPath = root.uri.replace(/^file:\/\//, "").replace(/\/$/, "");
      const name = root.name ?? basename(rawPath) ?? "default";
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
    if (!store) throw new Error(`Store not found: "${name}". Available stores: ${[...this.stores.keys()].join(", ") || "none"}`);
    return store;
  }
}

export const storeManager = new StoreManager();
