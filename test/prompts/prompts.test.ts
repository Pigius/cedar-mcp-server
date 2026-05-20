import { describe, it, expect } from "vitest";
import { PROMPT_DEFINITIONS } from "../../src/prompts/index.js";

// Minimal stub for the extra argument the SDK passes to handlers.
// Prompts in this module do not use it, but the signature requires it.
const EXTRA = {} as Parameters<(typeof PROMPT_DEFINITIONS)[number]["handler"]>[1];

const byName = (name: string) => {
  const def = PROMPT_DEFINITIONS.find((p) => p.name === name);
  if (!def) throw new Error(`Prompt "${name}" not found in PROMPT_DEFINITIONS`);
  return def;
};

// ---------------------------------------------------------------------------
// cedar-review-policy-diff
// ---------------------------------------------------------------------------
describe("cedar-review-policy-diff", () => {
  const prompt = byName("cedar-review-policy-diff");

  it("returns non-empty messages array with required args", () => {
    const result = prompt.handler(
      { blue_store: "blue", green_store: "green" } as Parameters<typeof prompt.handler>[0],
      EXTRA
    );
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("assembled text references cedar_diff_policy_stores and both store names", () => {
    const result = prompt.handler(
      { blue_store: "prod", green_store: "staging" } as Parameters<typeof prompt.handler>[0],
      EXTRA
    );
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    expect(text).toContain("cedar_diff_policy_stores");
    expect(text).toContain("prod");
    expect(text).toContain("staging");
  });

  it("assembled text references cedar://schema URIs for both stores", () => {
    const result = prompt.handler(
      { blue_store: "blue", green_store: "green" } as Parameters<typeof prompt.handler>[0],
      EXTRA
    );
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    expect(text).toContain("cedar://schema/blue");
    expect(text).toContain("cedar://schema/green");
  });

  it("includes the optional focus note when focus is supplied", () => {
    const result = prompt.handler(
      {
        blue_store: "blue",
        green_store: "green",
        focus: "AVP immutability",
      } as Parameters<typeof prompt.handler>[0],
      EXTRA
    );
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    expect(text).toContain("AVP immutability");
  });

  it("omits the focus note when focus is not supplied", () => {
    const result = prompt.handler(
      { blue_store: "blue", green_store: "green" } as Parameters<typeof prompt.handler>[0],
      EXTRA
    );
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    expect(text).not.toContain("Focus area for this review:");
  });
});

// ---------------------------------------------------------------------------
// cedar-explain-denial
// ---------------------------------------------------------------------------
describe("cedar-explain-denial", () => {
  const prompt = byName("cedar-explain-denial");

  it("returns non-empty messages array with required args", () => {
    const result = prompt.handler(
      {
        principal: 'MyApp::User::"alice"',
        action: 'MyApp::Action::"read"',
        resource: 'MyApp::Document::"doc-1"',
        store: "mystore",
      } as Parameters<typeof prompt.handler>[0],
      EXTRA
    );
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("assembled text references cedar_authorize and cedar_explain", () => {
    const result = prompt.handler(
      {
        principal: 'MyApp::User::"alice"',
        action: 'MyApp::Action::"read"',
        resource: 'MyApp::Document::"doc-1"',
        store: "mystore",
      } as Parameters<typeof prompt.handler>[0],
      EXTRA
    );
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    expect(text).toContain("cedar_authorize");
    expect(text).toContain("cedar_explain");
  });

  it("assembled text includes cedar:// URIs for the named store", () => {
    const result = prompt.handler(
      {
        principal: 'MyApp::User::"bob"',
        action: 'MyApp::Action::"write"',
        resource: 'MyApp::Document::"doc-2"',
        store: "prod",
      } as Parameters<typeof prompt.handler>[0],
      EXTRA
    );
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    expect(text).toContain("cedar://policies/prod");
    expect(text).toContain("cedar://schema/prod");
    expect(text).toContain("cedar://entities/prod");
  });

  it("includes principal, action, and resource values in assembled text", () => {
    const principal = 'Acme::User::"carol"';
    const action = 'Acme::Action::"delete"';
    const resource = 'Acme::File::"file-99"';
    const result = prompt.handler(
      { principal, action, resource, store: "acme" } as Parameters<typeof prompt.handler>[0],
      EXTRA
    );
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    expect(text).toContain(principal);
    expect(text).toContain(action);
    expect(text).toContain(resource);
  });
});

// ---------------------------------------------------------------------------
// cedar-avp-migration-checklist
// ---------------------------------------------------------------------------
describe("cedar-avp-migration-checklist", () => {
  const prompt = byName("cedar-avp-migration-checklist");

  it("returns non-empty messages array with no args (all optional)", () => {
    const result = prompt.handler({} as Parameters<typeof prompt.handler>[0], EXTRA);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("uses placeholder namespace when none is provided", () => {
    const result = prompt.handler({} as Parameters<typeof prompt.handler>[0], EXTRA);
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    expect(text).toContain("<YourNamespace>");
  });

  it("substitutes the supplied namespace into the checklist", () => {
    const result = prompt.handler(
      { namespace: "MyApp" } as Parameters<typeof prompt.handler>[0],
      EXTRA
    );
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    expect(text).toContain("MyApp");
    expect(text).not.toContain("<YourNamespace>");
  });

  it("references all expected Cedar tools in the checklist", () => {
    const result = prompt.handler({} as Parameters<typeof prompt.handler>[0], EXTRA);
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    expect(text).toContain("cedar_validate_schema");
    expect(text).toContain("cedar_validate_entities");
    expect(text).toContain("cedar_link_template");
    expect(text).toContain("cedar_diff_schema");
    expect(text).toContain("cedar_diff_policy_stores");
  });
});
