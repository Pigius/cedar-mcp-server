import { describe, it, expect } from "vitest";
import { handleCheckChange } from "../../src/tools/check-change.js";

describe("cedar_check_policy_change", () => {
  it("4.1 — principal change requires recreate", async () => {
    const result = await handleCheckChange({
      old_policy: `permit(principal in MyApp::Role::"customer_account_access", action == MyApp::Action::"POST", resource);`,
      new_policy: `permit(principal in MyApp::Role::"customer_management_access", action == MyApp::Action::"POST", resource);`,
    });

    expect(result.can_update_in_place).toBe(false);
    const change = result.changes.find((c) => c.field === "principal");
    expect(change).toBeDefined();
    expect(change!.in_place_allowed).toBe(false);
  });

  it("4.2 — effect change (permit → forbid) requires recreate", async () => {
    const result = await handleCheckChange({
      old_policy: `permit(principal in MyApp::Role::"temp_access", action, resource);`,
      new_policy: `forbid(principal in MyApp::Role::"temp_access", action, resource);`,
    });

    expect(result.can_update_in_place).toBe(false);
    const change = result.changes.find((c) => c.field === "effect");
    expect(change).toBeDefined();
    expect(change!.in_place_allowed).toBe(false);
  });

  it("4.3 — resource change requires recreate", async () => {
    const result = await handleCheckChange({
      old_policy: `permit(principal, action == MyApp::Action::"read", resource == MyApp::Document::"doc-A");`,
      new_policy: `permit(principal, action == MyApp::Action::"read", resource == MyApp::Document::"doc-B");`,
    });

    expect(result.can_update_in_place).toBe(false);
    const change = result.changes.find((c) => c.field === "resource");
    expect(change).toBeDefined();
    expect(change!.in_place_allowed).toBe(false);
  });

  it("4.4 — action change is in-place OK", async () => {
    const result = await handleCheckChange({
      old_policy: `permit(principal in MyApp::Role::"editor", action == MyApp::Action::"read", resource);`,
      new_policy: `permit(principal in MyApp::Role::"editor", action in [MyApp::Action::"read", MyApp::Action::"write"], resource);`,
    });

    expect(result.can_update_in_place).toBe(true);
    const change = result.changes.find((c) => c.field === "action");
    expect(change).toBeDefined();
    expect(change!.in_place_allowed).toBe(true);
  });

  it("4.5 — condition change is in-place OK", async () => {
    const result = await handleCheckChange({
      old_policy: `permit(principal, action, resource) when { principal.name == "user_a" && resource.status == "active" };`,
      new_policy: `permit(principal, action, resource) when { principal.name == "user_a" && ["active", "pending"].contains(resource.status) };`,
    });

    expect(result.can_update_in_place).toBe(true);
    const change = result.changes.find((c) => c.field === "conditions");
    expect(change).toBeDefined();
    expect(change!.in_place_allowed).toBe(true);
  });

  it("4.6 — mixed changes: principal blocks in-place even though action + condition are OK", async () => {
    const result = await handleCheckChange({
      old_policy: `permit(
        principal in MyApp::Role::"old_role",
        action == MyApp::Action::"read",
        resource
      ) when { resource.status == "active" };`,
      new_policy: `permit(
        principal in MyApp::Role::"new_role",
        action in [MyApp::Action::"read", MyApp::Action::"write"],
        resource
      ) when { resource.status == "active" || resource.status == "pending" };`,
    });

    expect(result.can_update_in_place).toBe(false);
    expect(result.changes.find((c) => c.field === "principal")?.in_place_allowed).toBe(false);
    expect(result.changes.find((c) => c.field === "action")?.in_place_allowed).toBe(true);
    expect(result.changes.find((c) => c.field === "conditions")?.in_place_allowed).toBe(true);
  });

  it("4.7 — identical policies: no changes, can update in place", async () => {
    const policy = `permit(principal in MyApp::Role::"viewer", action == MyApp::Action::"read", resource);`;
    const result = await handleCheckChange({ old_policy: policy, new_policy: policy });

    expect(result.can_update_in_place).toBe(true);
    expect(result.changes).toHaveLength(0);
  });
});
