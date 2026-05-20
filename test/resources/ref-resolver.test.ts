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
    mkdirSync(join(tmpDir, "templates"), { recursive: true });
    mkdirSync(join(tmpDir, "template-links"), { recursive: true });
    mkdirSync(join(tmpDir, "entities"), { recursive: true });
    writeFileSync(join(tmpDir, "policies", "admin.cedar"), `permit(principal in DocMgmt::Role::"admin", action, resource);`);
    writeFileSync(join(tmpDir, "templates", "shared-read.cedar"), `permit(principal == ?principal, action == DocMgmt::Action::"READ", resource == ?resource);`);
    writeFileSync(
      join(tmpDir, "template-links", "link-01.json"),
      JSON.stringify({ template_id: "shared-read", slot_values: { "?principal": "DocMgmt::User::\"alice\"", "?resource": "DocMgmt::Document::\"doc1\"" } })
    );
    writeFileSync(join(tmpDir, "entities", "users.json"), JSON.stringify([{ uid: { type: "DocMgmt::User", id: "alice" }, attrs: {}, parents: [] }]));
    writeFileSync(join(tmpDir, "entities", "docs.json"), JSON.stringify([{ uid: { type: "DocMgmt::Document", id: "doc1" }, attrs: {}, parents: [] }]));
    writeFileSync(join(tmpDir, "schema.cedarschema"), `namespace DocMgmt { entity User; entity Document; action READ appliesTo { principal: [User], resource: [Document], context: {} }; }`);
    storeManager.loadFromRoots([{ uri: `file://${tmpDir}`, name: "mystore" }]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    storeManager.loadFromRoots([]);
  });

  // ─── Existing patterns ────────────────────────────────────────────────────

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

  // ─── Templates ────────────────────────────────────────────────────────────

  it("resolves cedar://templates/{store} to JSON array of template IDs", () => {
    const result = resolveRef("cedar://templates/mystore");
    expect("error" in result).toBe(false);
    if ("content" in result) {
      const ids = JSON.parse(result.content) as string[];
      expect(ids).toContain("shared-read");
      expect(result.resolved_from).toBe("cedar://templates/mystore");
    }
  });

  it("resolves cedar://templates/{store}/{id} to template body", () => {
    const result = resolveRef("cedar://templates/mystore/shared-read");
    expect("error" in result).toBe(false);
    if ("content" in result) {
      expect(result.content).toContain("?principal");
      expect(result.content).toContain("?resource");
    }
  });

  it("returns error for cedar://templates/{store}/{id} with unknown template", () => {
    const result = resolveRef("cedar://templates/mystore/ghost-template");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/template.*not found/i);
  });

  it("returns error for cedar://templates/{store} with unknown store", () => {
    const result = resolveRef("cedar://templates/ghost-store");
    expect("error" in result).toBe(true);
  });

  // ─── Template links ───────────────────────────────────────────────────────

  it("resolves cedar://template-links/{store} to JSON array of link IDs", () => {
    const result = resolveRef("cedar://template-links/mystore");
    expect("error" in result).toBe(false);
    if ("content" in result) {
      const ids = JSON.parse(result.content) as string[];
      expect(ids).toContain("link-01");
      expect(result.resolved_from).toBe("cedar://template-links/mystore");
    }
  });

  it("resolves cedar://template-links/{store}/{id} to link JSON content", () => {
    const result = resolveRef("cedar://template-links/mystore/link-01");
    expect("error" in result).toBe(false);
    if ("content" in result) {
      const link = JSON.parse(result.content) as { template_id: string };
      expect(link.template_id).toBe("shared-read");
    }
  });

  it("returns error for cedar://template-links/{store}/{id} with unknown link", () => {
    const result = resolveRef("cedar://template-links/mystore/ghost-link");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/template link.*not found/i);
  });

  it("returns error for cedar://template-links/{store} with unknown store", () => {
    const result = resolveRef("cedar://template-links/ghost-store");
    expect("error" in result).toBe(true);
  });

  // ─── Entities ────────────────────────────────────────────────────────────

  it("resolves cedar://entities/{store} to merged JSON array from all entity files", () => {
    const result = resolveRef("cedar://entities/mystore");
    expect("error" in result).toBe(false);
    if ("content" in result) {
      const entities = JSON.parse(result.content) as Array<{ uid: { type: string; id: string } }>;
      expect(entities.length).toBe(2);
      const types = entities.map((e) => e.uid.type);
      expect(types).toContain("DocMgmt::User");
      expect(types).toContain("DocMgmt::Document");
      expect(result.resolved_from).toBe("cedar://entities/mystore");
    }
  });

  it("resolves cedar://entities/{store}/{file_id} to single entity file content", () => {
    const result = resolveRef("cedar://entities/mystore/users");
    expect("error" in result).toBe(false);
    if ("content" in result) {
      const parsed = JSON.parse(result.content) as Array<{ uid: { type: string } }>;
      expect(parsed[0]?.uid.type).toBe("DocMgmt::User");
    }
  });

  it("returns error for cedar://entities/{store}/{id} with unknown file", () => {
    const result = resolveRef("cedar://entities/mystore/ghost-file");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/entity file.*not found/i);
  });

  it("returns error for cedar://entities/{store} with unknown store", () => {
    const result = resolveRef("cedar://entities/ghost-store");
    expect("error" in result).toBe(true);
  });

  // ─── Falsifying input: non-array entity file should surface clean error ──

  it("returns error when an entity file contains a JSON object instead of array", () => {
    // This is the falsifying test: a plausible mistake is wrapping entities in an object.
    // readAllEntities must reject it, not silently produce wrong output.
    writeFileSync(
      join(tmpDir, "entities", "bad-shape.json"),
      JSON.stringify({ uid: { type: "DocMgmt::User", id: "bob" }, attrs: {}, parents: [] })
    );
    // Reload store so the new file is visible
    storeManager.loadFromRoots([{ uri: `file://${tmpDir}`, name: "mystore" }]);
    const result = resolveRef("cedar://entities/mystore");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/must contain a JSON array/i);
  });
});
