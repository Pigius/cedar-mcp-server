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
            status: { type: "String", required: false },
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

  // Fix 2: required schema attributes are populated on generated entities
  it("populates required schema attributes even when not mentioned in policy conditions", async () => {
    // The DocMgmt schema requires name+email on User and owner+classification on Document
    // The policy only checks role membership — no condition references these attrs
    // Without the fix, generated entities miss required attrs and validateRequest: true fails
    const result = await handleGenerateSample({
      policy: `permit(principal in DocMgmt::Role::"admin", action, resource);`,
      schema: DOCMGMT_SCHEMA_STR,
      target_decision: "allow",
    });

    expect(result.error).toBeUndefined();
    expect(result.decision).toBe("Allow");

    const principal = result.entities.find((e: { uid: { type: string } }) =>
      e.uid.type?.includes("User")
    );
    const resource = result.entities.find((e: { uid: { type: string } }) =>
      e.uid.type?.includes("Document")
    );

    // Required attrs from schema: User has name (String) and email (String)
    expect(principal?.attrs).toHaveProperty("name");
    expect(principal?.attrs).toHaveProperty("email");
    // Required attrs from schema: Document has owner (String) and classification (String)
    expect(resource?.attrs).toHaveProperty("owner");
    expect(resource?.attrs).toHaveProperty("classification");
  });

  // Fix 4: entity types read from schema instead of hardcoded User/Resource
  it("uses schema entity types (Endpoint not Resource) when defined in appliesTo", async () => {
    const result = await handleGenerateSample({
      policy: `permit(principal in Gateway::Role::"readonly", action in [Gateway::Action::"GET"], resource);`,
      schema: GATEWAY_SCHEMA,
      target_decision: "allow",
    });

    expect(result.error).toBeUndefined();
    expect(result.decision).toBe("Allow");
    // Principal should be Gateway::User (from appliesTo.principalTypes), not Gateway::User (same here)
    // Resource should be Gateway::Endpoint (from appliesTo.resourceTypes), not Gateway::Resource
    expect(result.resource).toContain("Gateway::Endpoint");
    expect(result.principal).toContain("Gateway::User");
  });

  // Fix 5: in/contains conditions extracted and satisfied
  it("extracts contains() conditions and satisfies them for allow", async () => {
    const result = await handleGenerateSample({
      policy: `permit(principal, action in [MyApp::Action::"READ"], resource) when { ["active", "pending"].contains(resource.status) };`,
      schema: ABAC_SCHEMA,
      target_decision: "allow",
    });

    expect(result.error).toBeUndefined();
    expect(result.decision).toBe("Allow");
    const resource = result.entities.find((e: { uid: { type: string } }) => e.uid.type?.includes("Resource"));
    expect(["active", "pending"]).toContain(resource?.attrs?.status);
  });

  it("extracts contains() conditions and violates them for deny", async () => {
    const result = await handleGenerateSample({
      policy: `permit(principal, action in [MyApp::Action::"READ"], resource) when { ["active", "pending"].contains(resource.status) };`,
      schema: ABAC_SCHEMA,
      target_decision: "deny",
    });

    expect(result.error).toBeUndefined();
    expect(result.decision).toBe("Deny");
    const resource = result.entities.find((e: { uid: { type: string } }) => e.uid.type?.includes("Resource"));
    expect(["active", "pending"]).not.toContain(resource?.attrs?.status);
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

  it("picks an action whose appliesTo matches the scope's principal type, not just the first declared action", async () => {
    // Regression for the v1 → v2 fix of defaultActionIdFromSchema. v1 returned
    // Object.keys(actions)[0], which broke when the first action's
    // appliesTo.principalTypes didn't include the policy's principal type.
    //
    // Failure case: schema with `adminOnly` declared FIRST (admins only) and
    // `userRead` declared second (users only). A policy targeting a User would
    // pick `adminOnly` under v1, schema validation rejects, generator outputs
    // ready_to_test:false. Under v2 the generator picks `userRead`.
    const schemaWithOrder = JSON.stringify({
      Mismatch: {
        entityTypes: {
          User: { memberOfTypes: [], shape: { type: "Record", attributes: { name: { type: "String", required: true } } } },
          Admin: { memberOfTypes: [], shape: { type: "Record", attributes: { name: { type: "String", required: true } } } },
          Doc: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
        },
        actions: {
          adminOnly: { appliesTo: { principalTypes: ["Admin"], resourceTypes: ["Doc"], context: { type: "Record", attributes: {} } } },
          userRead: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Doc"], context: { type: "Record", attributes: {} } } },
        },
      },
    });
    // Policy with NO action restriction — generator must default-pick an action.
    // The principal is a User (per generator's principalType picked from the
    // userRead action), so v2 should select `userRead`, not `adminOnly`.
    const policy = `permit (principal, action, resource);`;
    // Wait — extractScope picks principalType from the FIRST action's appliesTo
    // when actionId is undefined (see entityTypesFromSchema fallback). That
    // returns "Admin" (first action's principal type). So the generator would
    // build a request as Admin + adminOnly. Both pieces agree but the v2 fix
    // doesn't yet help because the principal type is also derived from the
    // first action.
    //
    // To exercise the v2 fix specifically, use a policy that PINS the principal
    // type (via `principal == User::"x"`) but leaves action unrestricted.
    const pinnedPolicy = `permit (principal == Mismatch::User::"alice", action, resource);`;

    const result = await handleGenerateSample({
      policy: pinnedPolicy,
      schema: schemaWithOrder,
      target_decision: "allow",
    });

    expect(result.error).toBeUndefined();
    // The generated action must match the User principal. adminOnly does NOT
    // include User in its appliesTo; userRead does. v2 must pick userRead.
    expect(result.action).toBe('Mismatch::Action::"userRead"');
    void policy;  // kept above as a written-out exploration; not used
  });

  // ─── kickoff-14 14b: double-namespace fix ──────────────────────────────────

  it("kickoff-14 14b: cedarschema-text schema produces single-prefix principal/resource (no MyApp::MyApp::User)", async () => {
    // The cwd-fallback path for cedar-sandbox supplies a .cedarschema text. The
    // Cedar WASM `schemaToJsonWithResolvedTypes` emits already-namespaced type
    // strings ("MyApp::User") for entries declared inside `namespace MyApp { ... }`.
    // The generator used to wrap that in `${namespace}::${type}` again,
    // producing `MyApp::MyApp::User::"sample-principal"`. Fix: skip re-prefixing
    // when the type name already contains "::".
    const cedarSchema = `namespace MyApp {
  entity User { name: String };
  entity Document { owner: String };
  action "read" appliesTo { principal: User, resource: Document };
}`;
    const result = await handleGenerateSample({
      policy: `permit (principal, action, resource);`,
      schema: cedarSchema,
      target_decision: "allow",
    });

    expect(result.error).toBeUndefined();
    expect(result.principal).toBe('MyApp::User::"sample-principal"');
    expect(result.resource).toBe('MyApp::Document::"sample-resource"');
    expect(result.action).toBe('MyApp::Action::"read"');
    // Entity uids must use the same single-namespace form (not "MyApp::MyApp::User").
    expect(result.entities.some((e) => e.uid.type === "MyApp::User" && e.uid.id === "sample-principal")).toBe(true);
    expect(result.entities.some((e) => e.uid.type === "MyApp::Document" && e.uid.id === "sample-resource")).toBe(true);
    expect(result.entities.every((e) => !e.uid.type.startsWith("MyApp::MyApp::"))).toBe(true);
  });

  it("kickoff-14 14b: a different namespace name (OtherApp) also gets single-prefix output", async () => {
    const cedarSchema = `namespace OtherApp {
  entity User { name: String };
  entity Document;
  action "read" appliesTo { principal: User, resource: Document };
}`;
    const result = await handleGenerateSample({
      policy: `permit (principal, action, resource);`,
      schema: cedarSchema,
      target_decision: "allow",
    });

    expect(result.error).toBeUndefined();
    expect(result.principal).toBe('OtherApp::User::"sample-principal"');
    expect(result.resource).toBe('OtherApp::Document::"sample-resource"');
    expect(result.entities.every((e) => !e.uid.type.startsWith("OtherApp::OtherApp::"))).toBe(true);
  });

  it("kickoff-14 14b: JSON-format schema (already bare types) keeps single namespace", async () => {
    // Regression: the JSON schema path supplies bare entity-type names ("User",
    // "Document"), so qualifyEntityType prefixes with the namespace. Existing
    // tests already exercise this path; this assertion just pins that the fix
    // didn't accidentally break it.
    const result = await handleGenerateSample({
      policy: `permit (principal, action, resource);`,
      schema: ABAC_SCHEMA,
      target_decision: "allow",
    });

    expect(result.error).toBeUndefined();
    expect(result.principal).toBe('MyApp::User::"sample-principal"');
    expect(result.resource).toBe('MyApp::Resource::"sample-resource"');
    expect(result.entities.every((e) => !e.uid.type.startsWith("MyApp::MyApp::"))).toBe(true);
  });
});
