import { describe, it, expect } from "vitest";
import { handleGenerateSample } from "../../src/tools/generate-sample.js";
import { SCHEMA_JSON } from "../fixtures/docmgmt.js";

const DOCMGMT_SCHEMA_STR = JSON.stringify(SCHEMA_JSON);

// Generic ABAC schema for cases 5.2-5.5
const ABAC_SCHEMA = JSON.stringify({
  MyApp: {
    entityTypes: {
      User: {
        memberOfTypes: [],
        shape: {
          type: "Record",
          attributes: {
            name: { type: "String", required: true },
          },
        },
      },
      Resource: {
        memberOfTypes: [],
        shape: {
          type: "Record",
          attributes: {
            type: { type: "String", required: true },
            region: { type: "String", required: true },
            tag: { type: "String", required: false },
          },
        },
      },
    },
    actions: {
      READ: {
        appliesTo: {
          principalTypes: ["User"],
          resourceTypes: ["Resource"],
          context: { type: "Record", attributes: {} },
        },
      },
    },
  },
});

describe("cedar_generate_sample_request", () => {
  it("5.1 — simple RBAC: generates allow request for admin role", async () => {
    const result = await handleGenerateSample({
      policy: `permit(principal in DocMgmt::Role::"admin", action, resource);`,
      schema: DOCMGMT_SCHEMA_STR,
      target_decision: "allow",
    });

    expect(result.error).toBeUndefined();
    expect(result.decision).toBe("Allow");
    expect(result.ready_to_test).toBe(true);
    expect(result.entities.some((e: { uid: { type: string } }) => e.uid.type === "DocMgmt::Role")).toBe(true);
  });

  it("5.2 — ABAC: generates allow request satisfying all conditions", async () => {
    const result = await handleGenerateSample({
      policy: `permit(
        principal,
        action in [MyApp::Action::"READ"],
        resource
      ) when {
        principal.name == "service_x" &&
        resource.type == "report" &&
        resource.region == "us-east"
      };`,
      schema: ABAC_SCHEMA,
      target_decision: "allow",
    });

    expect(result.error).toBeUndefined();
    expect(result.decision).toBe("Allow");
    expect(result.ready_to_test).toBe(true);
    // Principal should have name = "service_x"
    const principal = result.entities.find((e: { uid: { id: string } }) => e.uid.id === result.principal.split("::")?.[2]?.replace(/"/g, "") || e.uid.type?.includes("Identity"));
    expect(principal).toBeDefined();
  });

  it("5.3 — ABAC: generates deny request violating exactly one condition", async () => {
    const result = await handleGenerateSample({
      policy: `permit(
        principal,
        action in [MyApp::Action::"READ"],
        resource
      ) when {
        principal.name == "service_x" &&
        resource.type == "report" &&
        resource.region == "us-east"
      };`,
      schema: ABAC_SCHEMA,
      target_decision: "deny",
    });

    expect(result.error).toBeUndefined();
    expect(result.decision).toBe("Deny");
    expect(result.ready_to_test).toBe(true);
  });

  it("5.4 — optional attribute guard: allow request includes the optional attribute", async () => {
    const result = await handleGenerateSample({
      policy: `permit(
        principal,
        action in [MyApp::Action::"READ"],
        resource
      ) when {
        principal.name == "service_x" &&
        resource has tag &&
        resource.tag == "confidential"
      };`,
      schema: ABAC_SCHEMA,
      target_decision: "allow",
    });

    expect(result.error).toBeUndefined();
    expect(result.decision).toBe("Allow");
    const resource = result.entities.find((e: { uid: { type: string } }) => e.uid.type?.includes("Resource"));
    expect(resource?.attrs?.tag).toBe("confidential");
  });

  it("5.5 — optional attribute guard: deny request omits the guarded attribute", async () => {
    const result = await handleGenerateSample({
      policy: `permit(
        principal,
        action in [MyApp::Action::"READ"],
        resource
      ) when {
        principal.name == "service_x" &&
        resource has tag &&
        resource.tag == "confidential"
      };`,
      schema: ABAC_SCHEMA,
      target_decision: "deny",
    });

    expect(result.error).toBeUndefined();
    expect(result.decision).toBe("Deny");
    const resource = result.entities.find((e: { uid: { type: string } }) => e.uid.type?.includes("Resource"));
    // The resource should NOT have category (omitting the optional attr is the deny strategy)
    expect(resource?.attrs?.tag).toBeUndefined();
  });

  // Path-matching cases (require like operator support)
  // Schema: Gateway namespace with Endpoint entity having a path attribute

  const GATEWAY_SCHEMA = JSON.stringify({
    Gateway: {
      entityTypes: {
        User: {
          memberOfTypes: ["Role"],
          shape: { type: "Record", attributes: {} },
        },
        Role: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
        Endpoint: {
          memberOfTypes: [],
          shape: {
            type: "Record",
            attributes: {
              path: { type: "String", required: true },
            },
          },
        },
      },
      actions: {
        GET: {
          appliesTo: {
            principalTypes: ["User"],
            resourceTypes: ["Endpoint"],
            context: { type: "Record", attributes: {} },
          },
        },
      },
    },
  });

  const PATH_POLICY = `permit (
    principal in Gateway::Role::"readonly",
    action in [Gateway::Action::"GET"],
    resource
  )
  when {
    resource.path == "/api/v1/policies"
    || (
      resource.path like "/api/v1/policies/*"
      && !(resource.path like "/api/v1/policies/*/*")
    )
  };`;

  it("5.6 — path-matching allow: generated path satisfies the policy", async () => {
    const result = await handleGenerateSample({
      policy: PATH_POLICY,
      schema: GATEWAY_SCHEMA,
      target_decision: "allow",
    });

    expect(result.error).toBeUndefined();
    expect(result.decision).toBe("Allow");
    expect(result.ready_to_test).toBe(true);
  });

  it("5.7 — path-matching deny: generated path violates depth limit", async () => {
    const result = await handleGenerateSample({
      policy: PATH_POLICY,
      schema: GATEWAY_SCHEMA,
      target_decision: "deny",
    });

    expect(result.error).toBeUndefined();
    expect(result.decision).toBe("Deny");
    expect(result.ready_to_test).toBe(true);
  });
});
