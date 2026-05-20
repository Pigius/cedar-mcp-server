export const POLICIES = `
permit (
  principal in DocMgmt::Role::"admin",
  action,
  resource
);

permit (
  principal in DocMgmt::Role::"editor",
  action in [DocMgmt::Action::"read", DocMgmt::Action::"write"],
  resource
);

permit (
  principal in DocMgmt::Role::"viewer",
  action == DocMgmt::Action::"read",
  resource
);

forbid (
  principal,
  action,
  resource
)
when {
  resource.classification == "top_secret"
}
unless {
  principal in DocMgmt::Role::"admin"
};
`.trim();

export const SCHEMA_JSON = {
  DocMgmt: {
    entityTypes: {
      User: {
        memberOfTypes: ["Role"],
        shape: {
          type: "Record",
          attributes: {
            name: { type: "String", required: true },
            email: { type: "String", required: true },
          },
        },
      },
      Role: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
      Document: {
        memberOfTypes: ["Folder"],
        shape: {
          type: "Record",
          attributes: {
            owner: { type: "String", required: true },
            classification: { type: "String", required: true },
          },
        },
      },
      Folder: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
    },
    actions: {
      read: {
        appliesTo: {
          principalTypes: ["User"],
          resourceTypes: ["Document"],
          context: { type: "Record", attributes: {} },
        },
      },
      write: {
        appliesTo: {
          principalTypes: ["User"],
          resourceTypes: ["Document"],
          context: { type: "Record", attributes: {} },
        },
      },
      delete: {
        appliesTo: {
          principalTypes: ["User"],
          resourceTypes: ["Document"],
          context: { type: "Record", attributes: {} },
        },
      },
    },
  },
};

export const ENTITIES = [
  {
    uid: { type: "DocMgmt::User", id: "alice" },
    attrs: { name: "Alice Smith", email: "alice@example.com" },
    parents: [{ type: "DocMgmt::Role", id: "admin" }],
  },
  {
    uid: { type: "DocMgmt::User", id: "bob" },
    attrs: { name: "Bob Jones", email: "bob@example.com" },
    parents: [{ type: "DocMgmt::Role", id: "editor" }],
  },
  {
    uid: { type: "DocMgmt::User", id: "charlie" },
    attrs: { name: "Charlie Brown", email: "charlie@example.com" },
    parents: [{ type: "DocMgmt::Role", id: "viewer" }],
  },
  {
    uid: { type: "DocMgmt::User", id: "dave" },
    attrs: { name: "Dave Wilson", email: "dave@example.com" },
    parents: [],
  },
  { uid: { type: "DocMgmt::Role", id: "admin" }, attrs: {}, parents: [] },
  { uid: { type: "DocMgmt::Role", id: "editor" }, attrs: {}, parents: [] },
  { uid: { type: "DocMgmt::Role", id: "viewer" }, attrs: {}, parents: [] },
  {
    uid: { type: "DocMgmt::Document", id: "doc-public" },
    attrs: { owner: "alice", classification: "public" },
    parents: [{ type: "DocMgmt::Folder", id: "shared" }],
  },
  {
    uid: { type: "DocMgmt::Document", id: "doc-secret" },
    attrs: { owner: "alice", classification: "top_secret" },
    parents: [{ type: "DocMgmt::Folder", id: "classified" }],
  },
  { uid: { type: "DocMgmt::Folder", id: "shared" }, attrs: {}, parents: [] },
  { uid: { type: "DocMgmt::Folder", id: "classified" }, attrs: {}, parents: [] },
];
