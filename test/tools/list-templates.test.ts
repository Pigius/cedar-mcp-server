import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleListTemplates } from "../../src/tools/list-templates.js";
import { handleListTemplateLinks } from "../../src/tools/list-template-links.js";
import { StoreManager } from "../../src/resources/store-manager.js";

const TEMPLATE_A = `permit(principal == ?principal, action == App::Action::"read", resource == ?resource);`;
const TEMPLATE_B = `permit(principal, action == App::Action::"write", resource == ?resource);`;

function makeStore(baseDir: string, opts: {
  templates?: Record<string, string>;
  links?: Record<string, object>;
} = {}): { manager: StoreManager; storePath: string } {
  const storePath = join(baseDir, "mystore");
  mkdirSync(join(storePath, "policies"), { recursive: true });
  writeFileSync(join(storePath, "schema.cedarschema"), "namespace App {}");

  if (opts.templates) {
    mkdirSync(join(storePath, "templates"), { recursive: true });
    for (const [id, content] of Object.entries(opts.templates)) {
      writeFileSync(join(storePath, "templates", `${id}.cedar`), content);
    }
  }

  if (opts.links) {
    mkdirSync(join(storePath, "template-links"), { recursive: true });
    for (const [id, data] of Object.entries(opts.links)) {
      writeFileSync(join(storePath, "template-links", `${id}.json`), JSON.stringify(data));
    }
  }

  const manager = new StoreManager();
  manager.loadFromRoots([{ uri: `file://${storePath}`, name: "mystore" }]);
  return { manager, storePath };
}

describe("cedar_list_templates", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cedar-list-tmpl-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("LST1 — lists all templates in store with id and slot info", async () => {
    const { manager } = makeStore(tmpDir, {
      templates: { "viewer-access": TEMPLATE_A, "writer-access": TEMPLATE_B },
    });

    const result = await handleListTemplates({ store: "mystore" }, manager);

    expect(result.error).toBeUndefined();
    expect(result.store).toBe("mystore");
    expect(result.templates).toHaveLength(2);
    const ids = result.templates.map(t => t.id);
    expect(ids).toContain("viewer-access");
    expect(ids).toContain("writer-access");
    const viewerTmpl = result.templates.find(t => t.id === "viewer-access")!;
    expect(viewerTmpl.slots).toContain("?principal");
    expect(viewerTmpl.slots).toContain("?resource");
    const writerTmpl = result.templates.find(t => t.id === "writer-access")!;
    expect(writerTmpl.slots).toContain("?resource");
    expect(writerTmpl.slots).not.toContain("?principal");
  });

  it("LST2 — returns empty list when no templates directory", async () => {
    const { manager } = makeStore(tmpDir);

    const result = await handleListTemplates({ store: "mystore" }, manager);

    expect(result.error).toBeUndefined();
    expect(result.templates).toHaveLength(0);
  });

  it("LST3 — returns error for unknown store", async () => {
    const { manager } = makeStore(tmpDir);

    const result = await handleListTemplates({ store: "nonexistent" }, manager);

    expect(result.error).toBeDefined();
  });
});

describe("cedar_list_template_links", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cedar-list-links-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("LSTL1 — lists template links with template_id and slot_values", async () => {
    const { manager } = makeStore(tmpDir, {
      links: {
        "alice-doc42": { template_id: "viewer-access", slot_values: { "?principal": 'App::User::"alice"', "?resource": 'App::Document::"doc-42"' } },
        "bob-doc99": { template_id: "viewer-access", slot_values: { "?principal": 'App::User::"bob"', "?resource": 'App::Document::"doc-99"' } },
      },
    });

    const result = await handleListTemplateLinks({ store: "mystore" }, manager);

    expect(result.error).toBeUndefined();
    expect(result.store).toBe("mystore");
    expect(result.links).toHaveLength(2);
    const alice = result.links.find(l => l.id === "alice-doc42")!;
    expect(alice.template_id).toBe("viewer-access");
    expect(alice.slot_values["?principal"]).toBe('App::User::"alice"');
  });

  it("LSTL2 — returns empty list when no template-links directory", async () => {
    const { manager } = makeStore(tmpDir);

    const result = await handleListTemplateLinks({ store: "mystore" }, manager);

    expect(result.error).toBeUndefined();
    expect(result.links).toHaveLength(0);
  });

  it("LSTL3 — returns error for unknown store", async () => {
    const { manager } = makeStore(tmpDir);

    const result = await handleListTemplateLinks({ store: "nonexistent" }, manager);

    expect(result.error).toBeDefined();
  });
});
