import { describe, it, expect } from "vitest";
import { handleLinkTemplate } from "../../src/tools/link-template.js";

const SCHEMA = `namespace App {
  entity User;
  entity Document;
  action read appliesTo { principal: [User], resource: [Document], context: {} };
}`;

const BOTH_SLOTS_TEMPLATE = `permit(
  principal == ?principal,
  action == App::Action::"read",
  resource == ?resource
);`;

const RESOURCE_ONLY_TEMPLATE = `permit(
  principal,
  action == App::Action::"read",
  resource == ?resource
);`;

describe("cedar_link_template", () => {
  it("LT1 — links both slots to produce a valid Cedar policy", async () => {
    const result = await handleLinkTemplate({
      template: BOTH_SLOTS_TEMPLATE,
      principal: 'App::User::"alice"',
      resource: 'App::Document::"doc-42"',
    });

    expect(result.error).toBeUndefined();
    expect(result.linked_policy).toContain('App::User::"alice"');
    expect(result.linked_policy).toContain('App::Document::"doc-42"');
    expect(result.slots_bound).toHaveProperty("?principal");
    expect(result.slots_bound).toHaveProperty("?resource");
  });

  it("LT2 — linked policy validates against schema when schema provided", async () => {
    const result = await handleLinkTemplate({
      template: BOTH_SLOTS_TEMPLATE,
      principal: 'App::User::"alice"',
      resource: 'App::Document::"doc-42"',
      schema: SCHEMA,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("LT3 — missing required slot returns error", async () => {
    const result = await handleLinkTemplate({
      template: BOTH_SLOTS_TEMPLATE,
      // ?principal provided but ?resource missing
      principal: 'App::User::"alice"',
    });

    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/\?resource/);
  });

  it("LT4 — resource-only template links with only resource slot", async () => {
    const result = await handleLinkTemplate({
      template: RESOURCE_ONLY_TEMPLATE,
      resource: 'App::Document::"doc-99"',
    });

    expect(result.error).toBeUndefined();
    expect(result.linked_policy).toContain('App::Document::"doc-99"');
    expect(result.slots_bound).not.toHaveProperty("?principal");
  });

  it("LT5 — invalid template text returns error", async () => {
    const result = await handleLinkTemplate({
      template: "not valid cedar",
      principal: 'App::User::"alice"',
      resource: 'App::Document::"doc-1"',
    });

    expect(result.error).toBeDefined();
  });

  it("LT6 — invalid entity ref format returns error", async () => {
    const result = await handleLinkTemplate({
      template: BOTH_SLOTS_TEMPLATE,
      principal: "not-an-entity-ref",
      resource: 'App::Document::"doc-1"',
    });

    expect(result.error).toBeDefined();
  });
});
