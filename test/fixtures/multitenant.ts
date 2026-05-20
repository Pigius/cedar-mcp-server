// Dataset 2: ABAC — Multi-Tenant Insurance Platform
// Namespace: Insurance
// Principals are Identity entities carrying a `name` attribute; policies check
// principal.name directly (attribute-based, not role-based membership).
// Resources are Policy entities with vertical, business_unit, and optional insurer.
// This exercises: name-based identity, array containment, optional attribute guard,
// multi-attribute ABAC — all patterns absent from Dataset 1 (DocMgmt RBAC).

export const POLICIES = `
permit (
  principal,
  action in [Insurance::Action::"READ"],
  resource
)
when {
  principal.name == "tenant-a" &&
  ["tradesmen_and_professionals", "shops_and_salons"].contains(resource.vertical) &&
  resource.business_unit == "mga_uk"
};

permit (
  principal,
  action,
  resource
)
when {
  principal.name == "bruno"
};

permit (
  principal,
  action in [Insurance::Action::"READ"],
  resource
)
when {
  principal.name == "tenant-b-user" &&
  resource has insurer &&
  ["Harborway Insurance"].contains(resource.insurer) &&
  resource.business_unit == "simplybusiness_us"
};

permit (
  principal,
  action in [Insurance::Action::"CREATE", Insurance::Action::"READ"],
  resource
)
when {
  principal.name == "tenant-d"
};
`.trim();

export const SCHEMA_JSON = {
  Insurance: {
    entityTypes: {
      Identity: {
        memberOfTypes: ["Role"],
        shape: {
          type: "Record",
          attributes: {
            name: { type: "String", required: true },
          },
        },
      },
      Role: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
      Policy: {
        memberOfTypes: [],
        shape: {
          type: "Record",
          attributes: {
            vertical: { type: "String", required: true },
            business_unit: { type: "String", required: true },
            insurer: { type: "String", required: false },
          },
        },
      },
    },
    actions: {
      CREATE: {
        appliesTo: {
          principalTypes: ["Identity"],
          resourceTypes: ["Policy"],
          context: { type: "Record", attributes: {} },
        },
      },
      READ: {
        appliesTo: {
          principalTypes: ["Identity"],
          resourceTypes: ["Policy"],
          context: { type: "Record", attributes: {} },
        },
      },
      UPDATE: {
        appliesTo: {
          principalTypes: ["Identity"],
          resourceTypes: ["Policy"],
          context: { type: "Record", attributes: {} },
        },
      },
    },
  },
};

export const ENTITIES = [
  // Principals
  {
    uid: { type: "Insurance::Identity", id: "tenant-a" },
    attrs: { name: "tenant-a" },
    parents: [{ type: "Insurance::Role", id: "partner" }],
  },
  {
    uid: { type: "Insurance::Identity", id: "tenant-c" },
    attrs: { name: "bruno" },
    parents: [{ type: "Insurance::Role", id: "internal" }],
  },
  {
    uid: { type: "Insurance::Identity", id: "tenant-b" },
    attrs: { name: "tenant-b-user" },
    parents: [{ type: "Insurance::Role", id: "partner" }],
  },
  {
    uid: { type: "Insurance::Identity", id: "tenant-d" },
    attrs: { name: "tenant-d" },
    parents: [{ type: "Insurance::Role", id: "internal" }],
  },
  {
    uid: { type: "Insurance::Identity", id: "unknown-client" },
    attrs: { name: "unknown_service" },
    parents: [],
  },
  // Roles
  { uid: { type: "Insurance::Role", id: "partner" }, attrs: {}, parents: [] },
  { uid: { type: "Insurance::Role", id: "internal" }, attrs: {}, parents: [] },
  // Resources — insurance policies
  {
    uid: { type: "Insurance::Policy", id: "POL-001" },
    attrs: { vertical: "tradesmen_and_professionals", business_unit: "mga_uk", insurer: "Aviva" },
    parents: [],
  },
  {
    uid: { type: "Insurance::Policy", id: "POL-002" },
    attrs: {
      vertical: "commercial_landlord",
      business_unit: "simplybusiness_us",
      insurer: "Harborway Insurance",
    },
    parents: [],
  },
  {
    uid: { type: "Insurance::Policy", id: "POL-003" },
    attrs: {
      vertical: "tradesmen_and_professionals",
      business_unit: "simplybusiness_us",
      insurer: "Harborway Insurance",
    },
    parents: [],
  },
  // POL-004 intentionally has no `insurer` attribute — tests optional attribute guard
  {
    uid: { type: "Insurance::Policy", id: "POL-004" },
    attrs: { vertical: "shops_and_salons", business_unit: "mga_uk" },
    parents: [],
  },
];
