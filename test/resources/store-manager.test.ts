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
});
