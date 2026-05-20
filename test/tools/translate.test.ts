import { describe, it, expect } from "vitest";
import { handleTranslate } from "../../src/tools/translate.js";
import { SCHEMA_JSON } from "../fixtures/docmgmt.js";

const SINGLE_POLICY = `permit (
  principal in DocMgmt::Role::"admin",
  action,
  resource
);`;

describe("cedar_translate", () => {
  describe("policy translation", () => {
    it("translates Cedar policy text to JSON", async () => {
      const result = await handleTranslate({
        input: SINGLE_POLICY,
        type: "policy",
        direction: "to_json",
      });

      expect(result.error).toBeNull();
      const json = JSON.parse(result.output!);
      expect(json.effect).toBe("permit");
      expect(json.principal.op).toBe("in");
    });

    it("translates policy JSON back to Cedar text", async () => {
      const policyJson = {
        effect: "permit",
        principal: { op: "in", entity: { type: "DocMgmt::Role", id: "admin" } },
        action: { op: "All" },
        resource: { op: "All" },
        conditions: [],
      };

      const result = await handleTranslate({
        input: JSON.stringify(policyJson),
        type: "policy",
        direction: "to_cedar",
      });

      expect(result.error).toBeNull();
      expect(result.output).toContain("permit");
      expect(result.output).toContain('DocMgmt::Role::"admin"');
    });
  });

  describe("schema translation", () => {
    it("translates Cedar schema JSON to Cedar text", async () => {
      const result = await handleTranslate({
        input: JSON.stringify(SCHEMA_JSON),
        type: "schema",
        direction: "to_cedar",
      });

      expect(result.error).toBeNull();
      expect(result.output).toContain("namespace DocMgmt");
      expect(result.output).toContain("entity User");
    });

    it("translates Cedar schema text to JSON", async () => {
      const cedarSchema = `namespace DocMgmt {
        entity User in [Role] = { name: String, email: String };
        entity Role;
        action read appliesTo { principal: [User], resource: [User], context: {} };
      }`;

      const result = await handleTranslate({
        input: cedarSchema,
        type: "schema",
        direction: "to_json",
      });

      expect(result.error).toBeNull();
      const json = JSON.parse(result.output!);
      expect(json.DocMgmt).toBeDefined();
    });

    it("returns error for invalid input", async () => {
      const result = await handleTranslate({
        input: "this is not a policy",
        type: "policy",
        direction: "to_json",
      });

      expect(result.error).not.toBeNull();
      expect(result.output).toBeNull();
    });
  });
});
