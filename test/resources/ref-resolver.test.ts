import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeManager } from "../../src/resources/store-manager.js";
import { resolveRef } from "../../src/resources/ref-resolver.js";

describe("resolveRef", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cedar-ref-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "policies"), { recursive: true });
    writeFileSync(join(tmpDir, "policies", "admin.cedar"), `permit(principal in DocMgmt::Role::"admin", action, resource);`);
    writeFileSync(join(tmpDir, "schema.cedarschema"), `namespace DocMgmt { entity User; }`);
    storeManager.loadFromRoots([{ uri: `file://${tmpDir}`, name: "mystore" }]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    storeManager.loadFromRoots([]);
  });

  it("resolves cedar://policies/{store} to all concatenated policies", () => {
    const result = resolveRef("cedar://policies/mystore");
    expect("error" in result).toBe(false);
    if ("content" in result) {
      expect(result.content).toContain("permit");
      expect(result.resolved_from).toBe("cedar://policies/mystore");
    }
  });

  it("resolves cedar://policies/{store}/{id} to single policy content", () => {
    const result = resolveRef("cedar://policies/mystore/admin");
    expect("error" in result).toBe(false);
    if ("content" in result) expect(result.content).toContain("admin");
  });

  it("resolves cedar://schema/{store} to schema content", () => {
    const result = resolveRef("cedar://schema/mystore");
    expect("error" in result).toBe(false);
    if ("content" in result) expect(result.content).toContain("DocMgmt");
  });

  it("returns error for unknown store", () => {
    const result = resolveRef("cedar://policies/ghost");
    expect("error" in result).toBe(true);
  });

  it("returns error for invalid URI", () => {
    const result = resolveRef("not-a-cedar-uri");
    expect("error" in result).toBe(true);
  });

  it("returns error for unrecognized URI pattern", () => {
    const result = resolveRef("cedar://unknown/something");
    expect("error" in result).toBe(true);
  });
});
