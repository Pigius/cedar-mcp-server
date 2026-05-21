import { describe, it, expect } from "vitest";
import {
  classifyAvpChange,
  AVP_VALIDATION_ERRORS,
} from "../../../src/tools/advise/avp-rules.js";

describe("classifyAvpChange", () => {
  describe("in-place targets via UpdatePolicy", () => {
    it.each([
      ["action"],
      ["when_clause"],
      ["unless_clause"],
      ["policy_name"],
    ])("classifies %s as in_place_via_update_policy", (changeField) => {
      const result = classifyAvpChange(changeField);
      expect(result.mode).toBe("in_place_via_update_policy");
      expect(result.rationale).toBeTruthy();
      expect(result.rationale.length).toBeGreaterThan(0);
    });
  });

  describe("delete-recreate targets", () => {
    it.each([
      ["effect"],
      ["principal"],
      ["resource"],
      ["policy_type_conversion"],
    ])("classifies %s as requires_delete_recreate", (changeField) => {
      const result = classifyAvpChange(changeField);
      expect(result.mode).toBe("requires_delete_recreate");
      expect(result.rationale).toBeTruthy();
      expect(result.rationale.length).toBeGreaterThan(0);
    });
  });

  describe("new policy path", () => {
    it("classifies new_policy as new_policy_via_create_policy", () => {
      const result = classifyAvpChange("new_policy");
      expect(result.mode).toBe("new_policy_via_create_policy");
      expect(result.rationale).toBeTruthy();
      expect(result.rationale.length).toBeGreaterThan(0);
    });
  });

  describe("default branch for unrecognized fields", () => {
    it.each([
      ["unrecognized_field"],
      [""],
    ])("falls through to in_place_via_update_policy for %j with unclassified rationale", (changeField) => {
      const result = classifyAvpChange(changeField);
      expect(result.mode).toBe("in_place_via_update_policy");
      expect(result.rationale).toContain("Change type unclassified");
      expect(result.rationale.length).toBeGreaterThan(0);
    });
  });
});

describe("AVP_VALIDATION_ERRORS constant", () => {
  it("contains exactly 10 entries", () => {
    expect(AVP_VALIDATION_ERRORS).toHaveLength(10);
  });

  it("every entry has a non-empty string id and description", () => {
    for (const entry of AVP_VALIDATION_ERRORS) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("has unique ids across all entries", () => {
    const ids = AVP_VALIDATION_ERRORS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
