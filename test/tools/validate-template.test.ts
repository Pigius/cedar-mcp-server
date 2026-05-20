import { describe, it, expect } from "vitest";
import { handleValidateTemplate } from "../../src/tools/validate-template.js";

const SCHEMA = `namespace App {
  entity User;
  entity Document;
  action read appliesTo { principal: [User], resource: [Document], context: {} };
  action write appliesTo { principal: [User], resource: [Document], context: {} };
}`;

const VALID_TEMPLATE = `permit(
  principal == ?principal,
  action == App::Action::"read",
  resource == ?resource
);`;

const RESOURCE_ONLY_TEMPLATE = `permit(
  principal,
  action == App::Action::"read",
  resource == ?resource
);`;

describe("cedar_validate_template", () => {
  it("VT1 — valid template returns valid:true and detected slots", async () => {
    const result = await handleValidateTemplate({ template: VALID_TEMPLATE, schema: SCHEMA });

    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.slots_detected).toContain("?principal");
    expect(result.slots_detected).toContain("?resource");
  });

  it("VT2 — template with only ?resource slot detected", async () => {
    const result = await handleValidateTemplate({ template: RESOURCE_ONLY_TEMPLATE, schema: SCHEMA });

    expect(result.valid).toBe(true);
    expect(result.slots_detected).toContain("?resource");
    expect(result.slots_detected).not.toContain("?principal");
  });

  it("VT3 — invalid Cedar syntax returns valid:false with errors", async () => {
    const result = await handleValidateTemplate({
      template: "this is not cedar !!@#$",
      schema: SCHEMA,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("VT4 — template with unknown action in schema returns validation error", async () => {
    const badTemplate = `permit(
      principal == ?principal,
      action == App::Action::"nonexistent",
      resource == ?resource
    );`;

    const result = await handleValidateTemplate({ template: badTemplate, schema: SCHEMA });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("VT5 — missing schema returns error", async () => {
    const result = await handleValidateTemplate({ template: VALID_TEMPLATE, schema: "" });

    expect(result.error).toBeDefined();
  });
});
