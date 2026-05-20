import { describe, it, expect } from "vitest";
import { handleAuthorize } from "../../src/tools/authorize.js";
import { POLICIES, SCHEMA_JSON, ENTITIES } from "../fixtures/docmgmt.js";

describe("cedar_authorize", () => {
  it("allows alice (admin) to read doc-public", async () => {
    const result = await handleAuthorize({
      policies: POLICIES,
      principal: 'DocMgmt::User::"alice"',
      action: 'DocMgmt::Action::"read"',
      resource: 'DocMgmt::Document::"doc-public"',
      entities: JSON.stringify(ENTITIES),
    });

    expect(result.decision).toBe("Allow");
    expect(result.errors).toHaveLength(0);
  });
});
