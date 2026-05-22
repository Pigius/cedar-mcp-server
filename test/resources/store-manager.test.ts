import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreManager } from "../../src/resources/store-manager.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function createTestStore(baseDir: string, storeName: string): string {
  const storePath = join(baseDir, storeName);
  mkdirSync(join(storePath, "policies"), { recursive: true });

  writeFileSync(
    join(storePath, "policies", "admin.cedar"),
    `permit(principal in DocMgmt::Role::"admin", action, resource);`
  );
  writeFileSync(
    join(storePath, "policies", "viewer.cedar"),
    `permit(principal in DocMgmt::Role::"viewer", action == DocMgmt::Action::"READ", resource);`
  );
  writeFileSync(
    join(storePath, "schema.cedarschema"),
    `namespace DocMgmt { entity User in [Role]; entity Role; entity Document; action READ appliesTo { principal: [User], resource: [Document], context: {} }; }`
  );
  return storePath;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("StoreManager", () => {
  let tmpDir: string;
  let manager: StoreManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cedar-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    manager = new StoreManager();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadFromRoots", () => {
    it("loads a single root as a named store", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(manager.listStoreNames()).toContain("blue");
    });

    it("derives store name from URI last segment when root has no name", () => {
      const storePath = createTestStore(tmpDir, "production");
      manager.loadFromRoots([{ uri: `file://${storePath}` }]);
      expect(manager.listStoreNames()).toContain("production");
    });

    it("loads multiple roots as separate stores", () => {
      createTestStore(tmpDir, "blue");
      createTestStore(tmpDir, "green");
      manager.loadFromRoots([
        { uri: `file://${tmpDir}/blue`, name: "blue" },
        { uri: `file://${tmpDir}/green`, name: "green" },
      ]);
      expect(manager.listStoreNames()).toEqual(expect.arrayContaining(["blue", "green"]));
    });

    it("clears previous stores on reload", () => {
      createTestStore(tmpDir, "old");
      manager.loadFromRoots([{ uri: `file://${tmpDir}/old`, name: "old" }]);
      expect(manager.listStoreNames()).toContain("old");

      createTestStore(tmpDir, "new");
      manager.loadFromRoots([{ uri: `file://${tmpDir}/new`, name: "new" }]);
      expect(manager.listStoreNames()).not.toContain("old");
      expect(manager.listStoreNames()).toContain("new");
    });

    it("handles trailing slash in root URI", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}/` }]);
      expect(manager.listStoreNames()).toContain("blue");
    });
  });

  describe("listPolicies", () => {
    it("returns policy IDs (filenames without .cedar extension)", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      const policies = manager.listPolicies("blue");
      expect(policies).toContain("admin");
      expect(policies).toContain("viewer");
    });

    it("returns empty array when policies directory does not exist", () => {
      mkdirSync(join(tmpDir, "empty"), { recursive: true });
      manager.loadFromRoots([{ uri: `file://${tmpDir}/empty`, name: "empty" }]);
      expect(manager.listPolicies("empty")).toEqual([]);
    });

    it("throws for unknown store name", () => {
      expect(() => manager.listPolicies("nonexistent")).toThrow(/store.*not found/i);
    });
  });

  describe("readPolicy", () => {
    it("returns policy content by ID", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      const content = manager.readPolicy("blue", "admin");
      expect(content).toContain("permit");
      expect(content).toContain("admin");
    });

    it("throws for unknown policy ID", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(() => manager.readPolicy("blue", "nonexistent")).toThrow(/policy.*not found/i);
    });

    it("throws for unknown store", () => {
      expect(() => manager.readPolicy("ghost", "admin")).toThrow(/store.*not found/i);
    });
  });

  describe("readSchema", () => {
    it("reads .cedarschema file", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      const schema = manager.readSchema("blue");
      expect(schema).toContain("DocMgmt");
    });

    it("reads schema.json when .cedarschema is absent", () => {
      mkdirSync(join(tmpDir, "json-store", "policies"), { recursive: true });
      writeFileSync(
        join(tmpDir, "json-store", "schema.json"),
        JSON.stringify({ DocMgmt: { entityTypes: {}, actions: {} } })
      );
      manager.loadFromRoots([{ uri: `file://${tmpDir}/json-store`, name: "json-store" }]);
      const schema = manager.readSchema("json-store");
      expect(schema).toContain("DocMgmt");
    });

    it("throws for unknown store", () => {
      expect(() => manager.readSchema("ghost")).toThrow(/store.*not found/i);
    });

    it("throws when no schema file exists in store", () => {
      mkdirSync(join(tmpDir, "no-schema", "policies"), { recursive: true });
      manager.loadFromRoots([{ uri: `file://${tmpDir}/no-schema`, name: "no-schema" }]);
      expect(() => manager.readSchema("no-schema")).toThrow(/schema.*not found/i);
    });
  });

  describe("readAllPolicies", () => {
    it("returns all policies concatenated", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      const all = manager.readAllPolicies("blue");
      expect(all).toContain("admin");
      expect(all).toContain("viewer");
    });
  });

  describe("security", () => {
    it("rejects non-file:// URIs at loadFromRoots time (does not silently accept)", () => {
      manager.loadFromRoots([{ uri: "https://example.com/policies", name: "remote" }]);
      // Non-file:// root should be skipped, not silently accepted
      expect(manager.listStoreNames()).not.toContain("remote");
    });

    it("disambiguates store names when two roots share the same last path segment", () => {
      // Two different paths but same last segment — should NOT silently overwrite
      mkdirSync(join(tmpDir, "team-a", "production", "policies"), { recursive: true });
      mkdirSync(join(tmpDir, "team-b", "production", "policies"), { recursive: true });
      writeFileSync(join(tmpDir, "team-a", "production", "schema.cedarschema"), "namespace A {}");
      writeFileSync(join(tmpDir, "team-b", "production", "schema.cedarschema"), "namespace B {}");

      manager.loadFromRoots([
        { uri: `file://${tmpDir}/team-a/production` },
        { uri: `file://${tmpDir}/team-b/production` },
      ]);

      // Both stores must survive — with disambiguated names
      expect(manager.listStoreNames().length).toBe(2);
    });

    it("rejects policy IDs with path traversal characters", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(() => manager.readPolicy("blue", "..")).toThrow(/Invalid policy ID/i);
      expect(() => manager.readPolicy("blue", "../../../etc/passwd")).toThrow(/Invalid policy ID/i);
      expect(() => manager.readPolicy("blue", "admin/subdir")).toThrow(/Invalid policy ID/i);
    });
  });

  describe("isPathAllowed", () => {
    it("returns true for paths inside a loaded root", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(manager.isPathAllowed(`${storePath}/policies/admin.cedar`)).toBe(true);
    });

    it("returns false for paths outside all roots", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(manager.isPathAllowed("/etc/passwd")).toBe(false);
    });
  });

  describe("listEntities", () => {
    it("returns entity file IDs (filenames without .json extension), sorted", () => {
      const storePath = createTestStore(tmpDir, "blue");
      mkdirSync(join(storePath, "entities"), { recursive: true });
      writeFileSync(join(storePath, "entities", "users.json"), JSON.stringify([]));
      writeFileSync(join(storePath, "entities", "docs.json"), JSON.stringify([]));
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(manager.listEntities("blue")).toEqual(["docs", "users"]);
    });

    it("returns empty array when entities directory does not exist", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(manager.listEntities("blue")).toEqual([]);
    });

    it("throws for unknown store name", () => {
      expect(() => manager.listEntities("nonexistent")).toThrow(/store.*not found/i);
    });
  });

  describe("readEntities", () => {
    it("returns entity file content as text", () => {
      const storePath = createTestStore(tmpDir, "blue");
      mkdirSync(join(storePath, "entities"), { recursive: true });
      const payload = JSON.stringify([{ uid: { type: "DocMgmt::User", id: "alice" }, attrs: {}, parents: [] }]);
      writeFileSync(join(storePath, "entities", "users.json"), payload);
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(manager.readEntities("blue", "users")).toBe(payload);
    });

    it("throws for unknown entity file ID", () => {
      const storePath = createTestStore(tmpDir, "blue");
      mkdirSync(join(storePath, "entities"), { recursive: true });
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(() => manager.readEntities("blue", "ghost")).toThrow(/entity file.*not found/i);
    });

    it("throws for path traversal in entity file ID", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(() => manager.readEntities("blue", "..")).toThrow(/Invalid entity file ID/i);
      expect(() => manager.readEntities("blue", "../../../etc/passwd")).toThrow(/Invalid entity file ID/i);
    });

    it("throws for unknown store", () => {
      expect(() => manager.readEntities("ghost", "users")).toThrow(/store.*not found/i);
    });
  });

  describe("getDefaultStore (10d auto-discovery)", () => {
    it("returns { kind: 'none' } when no stores are loaded", () => {
      // Fresh manager — nothing loaded.
      const result = manager.getDefaultStore();
      expect(result.kind).toBe("none");
    });

    it("returns { kind: 'single', store } when exactly one store is loaded", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);

      const result = manager.getDefaultStore();
      expect(result.kind).toBe("single");
      if (result.kind === "single") {
        expect(result.store.name).toBe("blue");
        expect(result.store.path).toBe(storePath);
      }
    });

    it("returns { kind: 'ambiguous', names } when multiple stores are loaded", () => {
      createTestStore(tmpDir, "blue");
      createTestStore(tmpDir, "green");
      manager.loadFromRoots([
        { uri: `file://${tmpDir}/blue`, name: "blue" },
        { uri: `file://${tmpDir}/green`, name: "green" },
      ]);

      const result = manager.getDefaultStore();
      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(result.names).toEqual(expect.arrayContaining(["blue", "green"]));
        expect(result.names).toHaveLength(2);
      }
    });
  });

  describe("readAllEntities", () => {
    it("merges entity arrays from all files into one JSON array", () => {
      const storePath = createTestStore(tmpDir, "blue");
      mkdirSync(join(storePath, "entities"), { recursive: true });
      writeFileSync(
        join(storePath, "entities", "users.json"),
        JSON.stringify([{ uid: { type: "DocMgmt::User", id: "alice" }, attrs: {}, parents: [] }])
      );
      writeFileSync(
        join(storePath, "entities", "docs.json"),
        JSON.stringify([{ uid: { type: "DocMgmt::Document", id: "doc1" }, attrs: {}, parents: [] }])
      );
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      const merged = JSON.parse(manager.readAllEntities("blue")) as Array<{ uid: { type: string } }>;
      expect(merged.length).toBe(2);
      const types = merged.map((e) => e.uid.type);
      expect(types).toContain("DocMgmt::User");
      expect(types).toContain("DocMgmt::Document");
    });

    it("returns empty JSON array when entities directory is absent", () => {
      const storePath = createTestStore(tmpDir, "blue");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      const result = manager.readAllEntities("blue");
      expect(JSON.parse(result)).toEqual([]);
    });

    it("throws when an entity file contains a JSON object instead of an array", () => {
      // Falsifying input: an object is valid JSON but not a valid entity array — must error clearly.
      const storePath = createTestStore(tmpDir, "blue");
      mkdirSync(join(storePath, "entities"), { recursive: true });
      writeFileSync(
        join(storePath, "entities", "bad.json"),
        JSON.stringify({ uid: { type: "DocMgmt::User", id: "alice" }, attrs: {}, parents: [] })
      );
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(() => manager.readAllEntities("blue")).toThrow(/must contain a JSON array/i);
    });

    it("throws when an entity file contains invalid JSON", () => {
      const storePath = createTestStore(tmpDir, "blue");
      mkdirSync(join(storePath, "entities"), { recursive: true });
      writeFileSync(join(storePath, "entities", "broken.json"), "{ not valid json");
      manager.loadFromRoots([{ uri: `file://${storePath}`, name: "blue" }]);
      expect(() => manager.readAllEntities("blue")).toThrow(/invalid JSON/i);
    });
  });
});
