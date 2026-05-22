/**
 * Unit tests for the stdio entry-point helpers in src/index.ts. Tests that
 * need a real spawned process live in test/integration/smoke.test.ts
 * (S6, S6b, S6c). These exercise the helpers directly.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { populateCwdFallback } from "../src/index.js";
import { storeManager } from "../src/resources/store-manager.js";

describe("populateCwdFallback — kickoff-12 sync cwd-fallback (Round 5 Scenario E fix)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    // Reset the singleton so per-test state never leaks.
    storeManager.loadFromRoots([]);
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true and loads the store when cwd has schema.cedarschema", () => {
    const dir = mkdtempSync(join(tmpdir(), "cedar-sync-schema-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "schema.cedarschema"), `namespace DocMgmt {}`);

    const loaded = populateCwdFallback(dir);

    expect(loaded).toBe(true);
    expect(storeManager.listStoreNames()).toEqual([basename(dir)]);
  });

  it("returns true and loads the store when cwd has schema.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "cedar-sync-json-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "schema.json"), `{"DocMgmt":{}}`);

    expect(populateCwdFallback(dir)).toBe(true);
    expect(storeManager.listStoreNames()).toEqual([basename(dir)]);
  });

  it("returns true and loads the store when cwd has only a policies/ directory (no schema)", () => {
    // This matches the 11d-audit Probe B scenario. populateCwdFallback fires;
    // cedar_advise's downstream auto-resolve then handles the schemaless case
    // via the `not_provided` degrade path landed in commit 0f35740.
    const dir = mkdtempSync(join(tmpdir(), "cedar-sync-policiesonly-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "policies"));

    expect(populateCwdFallback(dir)).toBe(true);
    expect(storeManager.listStoreNames()).toEqual([basename(dir)]);
  });

  it("returns false and leaves StoreManager untouched when cwd does not look like a Cedar workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "cedar-sync-empty-"));
    tempDirs.push(dir);
    // Empty directory — no schema.cedarschema, no schema.json, no policies/.

    expect(populateCwdFallback(dir)).toBe(false);
    expect(storeManager.listStoreNames()).toEqual([]);
  });

  it("populates StoreManager synchronously (caller can observe state immediately on the next line)", () => {
    // The whole point of 12a: the call returns AFTER state is mutated, with
    // no async gap. A caller reading listStoreNames() on the next statement
    // must see the populated store. If populateCwdFallback ever becomes
    // async, every caller that relies on this property breaks.
    const dir = mkdtempSync(join(tmpdir(), "cedar-sync-immediate-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "schema.cedarschema"), `namespace DocMgmt {}`);

    populateCwdFallback(dir);
    // Immediate read — no awaits, no microtask boundary.
    const names = storeManager.listStoreNames();

    expect(names).toEqual([basename(dir)]);
  });
});
