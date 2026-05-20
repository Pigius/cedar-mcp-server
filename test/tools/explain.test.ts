import { describe, it, expect } from "vitest";
import { handleExplain } from "../../src/tools/explain.js";

// Dataset 7 test cases — generic attribute names only.

describe("cedar_explain", () => {
  it("7.1 — simple RBAC: permit, role membership, unrestricted action and resource", async () => {
    const result = await handleExplain({
      policy: `permit(
        principal in MyApp::Role::"admin",
        action,
        resource
      );`,
    });

    expect(result.effect).toBe("permit");
    expect(result.principal.description).toContain("admin");
    expect(result.action.description).toContain("any action");
    expect(result.resource.description).toContain("any resource");
    expect(result.conditions).toHaveLength(0);
    expect(result.summary).toMatch(/PERMITS/i);
    expect(result.patterns_detected).toContain("role_based_access");
    expect(result.patterns_detected).toContain("unrestricted_action");
    expect(result.patterns_detected).toContain("unrestricted_resource");
  });

  it("7.2 — forbid with unless: attribute condition + role exemption", async () => {
    const result = await handleExplain({
      policy: `forbid (principal, action, resource)
        when { resource.classification == "top_secret" }
        unless { principal in DocMgmt::Role::"admin" };`,
    });

    expect(result.effect).toBe("forbid");
    expect(result.principal.description).toContain("any principal");
    expect(result.conditions).toHaveLength(2);
    expect(result.conditions[0]!.kind).toBe("when");
    expect(result.conditions[1]!.kind).toBe("unless");
    expect(result.summary).toMatch(/FORBIDS/i);
    expect(result.patterns_detected).toContain("forbid_policy");
    expect(result.patterns_detected).toContain("role_exemption");
  });

  it("7.3 — ABAC with optional attribute guard", async () => {
    const result = await handleExplain({
      policy: `permit (principal, action in [DocMgmt::Action::"READ"], resource)
        when {
          principal.name == "service_x" &&
          resource has tag &&
          resource.tag == "confidential"
        };`,
    });


    expect(result.effect).toBe("permit");
    expect(result.principal.description).toContain("any principal");
    expect(result.action.description).toContain("READ");
    expect(result.conditions.length).toBeGreaterThan(0);
    expect(result.conditions[0]!.text).toContain("AND");
    expect(result.patterns_detected).toContain("optional_attribute_guard");
    expect(result.patterns_detected).toContain("name_based_identity");
    expect(result.summary).toMatch(/PERMITS/i);
  });

  it("7.3b — path-matching policy: like conditions render as Cedar syntax not 'complex condition'", async () => {
    const result = await handleExplain({
      policy: `permit (
        principal in DocMgmt::Role::"readonly",
        action in [DocMgmt::Action::"GET"],
        resource
      )
      when {
        resource.path like "/api/v1/policies/*"
        && !(resource.path like "/api/v1/policies/*/*")
      };`,
    });

    expect(result.effect).toBe("permit");
    expect(result.conditions.length).toBeGreaterThan(0);
    // Must render the like pattern, not fall back to "complex condition"
    expect(result.conditions[0]!.text).toContain("like");
    expect(result.conditions[0]!.text).toContain("/api/v1/policies/");
    expect(result.conditions[0]!.text).not.toBe("WHEN complex condition");
  });

  it("7.4 — template policy with ?principal and ?resource slots", async () => {
    const result = await handleExplain({
      policy: `permit(
        principal in ?principal,
        action == MyApp::Action::"GET",
        resource == ?resource
      );`,
    });

    expect(result.effect).toBe("permit");
    expect(result.principal.description).toContain("?principal");
    expect(result.resource.description).toContain("?resource");
    expect(result.patterns_detected).toContain("template_policy");
    expect(result.patterns_detected).toContain("slot_resource");
    expect(result.summary).toMatch(/TEMPLATE/i);
  });
});
