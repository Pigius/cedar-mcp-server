import { describe, it, expect } from "vitest";
import { handleFormat } from "../../src/tools/format.js";

describe("cedar_format", () => {
  it("formats a compact policy to canonical style", async () => {
    const result = await handleFormat({
      policies: `permit(principal in DocMgmt::Role::"admin",action,resource);`,
    });

    expect(result.formatted).toContain("permit (");
    expect(result.formatted).toContain('principal in DocMgmt::Role::"admin"');
    expect(result.error).toBeNull();
  });

  it("formats multiple policies", async () => {
    const result = await handleFormat({
      policies: `permit(principal,action,resource);forbid(principal,action,resource)when{resource.sensitive==true};`,
    });

    expect(result.formatted).toContain("permit (");
    expect(result.formatted).toContain("forbid (");
    expect(result.error).toBeNull();
  });

  it("returns error for syntactically invalid input", async () => {
    const result = await handleFormat({
      policies: `this is not cedar`,
    });

    expect(result.error).not.toBeNull();
    expect(result.formatted).toBeNull();
  });
});
