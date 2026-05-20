import { describe, it, expect } from "vitest";
import { handleDiffSchema } from "../../src/tools/diff-schema.js";

// Canonical Dataset 1 schema for diff tests. Keep small & focused so each
// test case is self-contained and the diff under test is obvious from inspection.
const BASE_SCHEMA = `
namespace App {
  entity User in [Role] = { name: String, email: String };
  entity Role;
  entity Document in [Folder] = { owner: String, classification: String };
  entity Folder;
  action READ, WRITE appliesTo {
    principal: [User],
    resource: [Document]
  };
}
`.trim();

describe("cedar_diff_schema — structural", () => {
  it("DS1: identical schemas produce an empty diff with risk_level safe", async () => {
    const result = await handleDiffSchema({ blue: BASE_SCHEMA, green: BASE_SCHEMA });

    expect(result.risk_level).toBe("safe");
    expect(result.entity_types.added).toHaveLength(0);
    expect(result.entity_types.removed).toHaveLength(0);
    expect(result.entity_types.modified).toHaveLength(0);
    expect(result.actions.added).toHaveLength(0);
    expect(result.actions.removed).toHaveLength(0);
    expect(result.actions.modified).toHaveLength(0);
    expect(result.summary).toMatch(/no schema changes/i);
  });

  it("DS2: entity type added in green → entity_types.added, risk safe", async () => {
    const green = BASE_SCHEMA.replace(
      "entity Folder;",
      "entity Folder;\n  entity Tag = { label: String };"
    );

    const result = await handleDiffSchema({ blue: BASE_SCHEMA, green });

    expect(result.entity_types.added).toContainEqual({ namespace: "App", name: "Tag" });
    expect(result.risk_level).toBe("safe");
  });

  it("DS3: entity type removed in green → entity_types.removed, risk breaking", async () => {
    const green = BASE_SCHEMA.replace("entity Folder;\n  ", "");
    // Folder is referenced in 'entity Document in [Folder]' — also strip that
    const greenClean = green.replace(" in [Folder]", "");

    const result = await handleDiffSchema({ blue: BASE_SCHEMA, green: greenClean });

    expect(result.entity_types.removed).toContainEqual(
      expect.objectContaining({ namespace: "App", name: "Folder", risk: "breaking" })
    );
    expect(result.risk_level).toBe("breaking");
  });
});

describe("cedar_diff_schema — attribute changes", () => {
  it("DS4a: optional attribute added → safe", async () => {
    const green = BASE_SCHEMA.replace(
      "{ name: String, email: String }",
      "{ name: String, email: String, phone?: String }"
    );

    const result = await handleDiffSchema({ blue: BASE_SCHEMA, green });

    const userMod = result.entity_types.modified.find((m) => m.name === "User");
    expect(userMod).toBeDefined();
    const phoneChange = userMod!.attribute_changes?.find((c) => c.attr === "phone");
    expect(phoneChange).toBeDefined();
    expect(phoneChange!.change).toBe("added");
    expect(phoneChange!.risk).toBe("safe");
  });

  it("DS4b: required attribute added → breaking", async () => {
    const green = BASE_SCHEMA.replace(
      "{ name: String, email: String }",
      "{ name: String, email: String, phone: String }"
    );

    const result = await handleDiffSchema({ blue: BASE_SCHEMA, green });

    const userMod = result.entity_types.modified.find((m) => m.name === "User");
    const phoneChange = userMod!.attribute_changes?.find((c) => c.attr === "phone");
    expect(phoneChange!.change).toBe("added");
    expect(phoneChange!.risk).toBe("breaking");
    expect(result.risk_level).toBe("breaking");
  });

  it("DS5: attribute removed → breaking", async () => {
    const green = BASE_SCHEMA.replace(
      "{ name: String, email: String }",
      "{ name: String }"
    );

    const result = await handleDiffSchema({ blue: BASE_SCHEMA, green });

    const userMod = result.entity_types.modified.find((m) => m.name === "User");
    const emailChange = userMod!.attribute_changes?.find((c) => c.attr === "email");
    expect(emailChange!.change).toBe("removed");
    expect(emailChange!.risk).toBe("breaking");
  });

  it("DS6: attribute type changed (String → Long) → breaking", async () => {
    const green = BASE_SCHEMA.replace(
      "{ name: String, email: String }",
      "{ name: Long, email: String }"
    );

    const result = await handleDiffSchema({ blue: BASE_SCHEMA, green });

    const userMod = result.entity_types.modified.find((m) => m.name === "User");
    const nameChange = userMod!.attribute_changes?.find((c) => c.attr === "name");
    expect(nameChange!.change).toBe("type_changed");
    expect(nameChange!.old_type).toBe("String");
    expect(nameChange!.new_type).toBe("Long");
    expect(nameChange!.risk).toBe("breaking");
  });
});

describe("cedar_diff_schema — action changes", () => {
  it("DS7: action added → safe", async () => {
    const green = BASE_SCHEMA.replace(
      "action READ, WRITE appliesTo",
      "action READ, WRITE, DELETE appliesTo"
    );

    const result = await handleDiffSchema({ blue: BASE_SCHEMA, green });

    expect(result.actions.added).toContainEqual({ namespace: "App", name: "DELETE" });
    expect(result.risk_level).toBe("safe");
  });

  it("DS8: action removed → breaking", async () => {
    const green = BASE_SCHEMA.replace("action READ, WRITE appliesTo", "action READ appliesTo");

    const result = await handleDiffSchema({ blue: BASE_SCHEMA, green });

    expect(result.actions.removed).toContainEqual(
      expect.objectContaining({ namespace: "App", name: "WRITE", risk: "breaking" })
    );
    expect(result.risk_level).toBe("breaking");
  });

  it("DS9: action principal_types widened → review", async () => {
    // Add a new principal type; action gains another principal type
    const blue = `
namespace App {
  entity User;
  entity Admin;
  entity Document;
  action READ appliesTo { principal: [User], resource: [Document] };
}
`.trim();
    const green = `
namespace App {
  entity User;
  entity Admin;
  entity Document;
  action READ appliesTo { principal: [User, Admin], resource: [Document] };
}
`.trim();

    const result = await handleDiffSchema({ blue, green });

    const readMod = result.actions.modified.find((m) => m.name === "READ");
    expect(readMod).toBeDefined();
    expect(readMod!.principal_types?.added).toEqual(["App::Admin"]);
    expect(readMod!.principal_types?.risk).toBe("review");
  });

  it("DS10: action principal_types narrowed → breaking", async () => {
    const blue = `
namespace App {
  entity User;
  entity Admin;
  entity Document;
  action READ appliesTo { principal: [User, Admin], resource: [Document] };
}
`.trim();
    const green = `
namespace App {
  entity User;
  entity Admin;
  entity Document;
  action READ appliesTo { principal: [User], resource: [Document] };
}
`.trim();

    const result = await handleDiffSchema({ blue, green });

    const readMod = result.actions.modified.find((m) => m.name === "READ");
    expect(readMod!.principal_types?.removed).toEqual(["App::Admin"]);
    expect(readMod!.principal_types?.risk).toBe("breaking");
  });
});

describe("cedar_diff_schema — input formats and errors", () => {
  it("DS13: malformed blue schema returns error result, not crash", async () => {
    const result = await handleDiffSchema({ blue: "not a schema", green: BASE_SCHEMA });

    expect(result.error).toBeTruthy();
  });

  it("DS14: blue and green in different formats (JSON vs cedarschema) — diff still works", async () => {
    const jsonForm = JSON.stringify({
      App: {
        entityTypes: {
          User: { memberOfTypes: [], shape: { type: "Record", attributes: { name: { type: "String", required: true } } } },
          Document: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
        },
        actions: {
          READ: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Document"] } },
        },
      },
    });
    const cedarForm = `
namespace App {
  entity User = { name: String };
  entity Document;
  action READ appliesTo { principal: [User], resource: [Document] };
}
`.trim();

    const result = await handleDiffSchema({ blue: jsonForm, green: cedarForm });

    // Same logical content — diff should be empty
    expect(result.entity_types.added).toHaveLength(0);
    expect(result.entity_types.removed).toHaveLength(0);
    expect(result.entity_types.modified).toHaveLength(0);
    expect(result.actions.added).toHaveLength(0);
    expect(result.actions.removed).toHaveLength(0);
  });
});

describe("cedar_diff_schema — falsification: diff predicts cedar_validate outcome", () => {
  it("DSF: when diff says 'breaking' for an attribute removal, a policy referencing the attribute fails cedar_validate against green", async () => {
    const { handleValidate } = await import("../../src/tools/validate.js");

    const blue = `
namespace App {
  entity User = { name: String, email: String };
  entity Doc;
  action READ appliesTo { principal: [User], resource: [Doc] };
}
`.trim();
    const green = `
namespace App {
  entity User = { name: String };
  entity Doc;
  action READ appliesTo { principal: [User], resource: [Doc] };
}
`.trim();
    const policy = `permit (principal, action, resource) when { principal.email == "alice@x.y" };`;

    // 1. Policy is valid against blue
    const blueValidation = await handleValidate({ policies: policy, schema: blue });
    expect(blueValidation.valid).toBe(true);

    // 2. Diff classifies email removal as breaking
    const diff = await handleDiffSchema({ blue, green });
    const userMod = diff.entity_types.modified.find((m) => m.name === "User");
    expect(userMod).toBeDefined();
    const emailChange = userMod!.attribute_changes?.find((c) => c.attr === "email");
    expect(emailChange!.change).toBe("removed");
    expect(emailChange!.risk).toBe("breaking");

    // 3. Policy is INVALID against green — falsification check passes
    const greenValidation = await handleValidate({ policies: policy, schema: green });
    expect(greenValidation.valid).toBe(false);
  });
});

describe("cedar_diff_schema — namespace changes", () => {
  it("DS15: namespace added → namespaces_added has it; all entities in new ns reported as added", async () => {
    const green = `
namespace App {
  entity User;
  entity Role;
  entity Document in [Folder];
  entity Folder;
  action READ, WRITE appliesTo {
    principal: [User],
    resource: [Document]
  };
}

namespace Audit {
  entity Event = { kind: String };
  action LOG appliesTo { principal: [App::User], resource: [Event] };
}
`.trim();
    const blue = `
namespace App {
  entity User in [Role] = { name: String, email: String };
  entity Role;
  entity Document in [Folder] = { owner: String, classification: String };
  entity Folder;
  action READ, WRITE appliesTo {
    principal: [User],
    resource: [Document]
  };
}
`.trim();
    // Use a simpler blue without attrs so we just check namespace addition behavior
    const simpleBlue = `
namespace App {
  entity User;
  entity Role;
  entity Document in [Folder];
  entity Folder;
  action READ, WRITE appliesTo {
    principal: [User],
    resource: [Document]
  };
}
`.trim();

    const result = await handleDiffSchema({ blue: simpleBlue, green });

    expect(result.namespaces_added).toContain("Audit");
    expect(result.entity_types.added).toContainEqual({ namespace: "Audit", name: "Event" });
    expect(result.actions.added).toContainEqual({ namespace: "Audit", name: "LOG" });
  });

  it("DS16: namespace removed → namespaces_removed has it, all entities in removed ns reported as breaking removed", async () => {
    const blue = `
namespace App {
  entity User;
}

namespace Audit {
  entity Event = { kind: String };
  action LOG appliesTo { principal: [App::User], resource: [Event] };
}
`.trim();
    const green = `
namespace App {
  entity User;
}
`.trim();

    const result = await handleDiffSchema({ blue, green });

    expect(result.namespaces_removed).toContain("Audit");
    expect(result.entity_types.removed).toContainEqual(
      expect.objectContaining({ namespace: "Audit", name: "Event", risk: "breaking" })
    );
    expect(result.actions.removed).toContainEqual(
      expect.objectContaining({ namespace: "Audit", name: "LOG", risk: "breaking" })
    );
    expect(result.risk_level).toBe("breaking");
  });
});
