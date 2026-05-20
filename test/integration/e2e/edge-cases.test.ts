/**
 * E2E layer 4: edge cases.
 *
 * Boundary inputs that exercise unusual but VALID parts of the Cedar surface.
 * Failure-mode coverage (inputs the server should reject cleanly) lives in
 * failure-modes.test.ts.
 *
 * Each test states the boundary it probes and the failure case it would catch.
 *
 * Run: npx vitest run test/integration/e2e/edge-cases
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(import.meta.dirname, "../../..");

function makeStdioClient(): { client: Client; transport: StdioClientTransport } {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    cwd: repoRoot,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "e2e-edge", version: "1.0.0" },
    { capabilities: {} }
  );
  return { client, transport };
}

function parseToolResult(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const textBlock = r.content?.find((b) => b.type === "text");
  if (!textBlock?.text) throw new Error("No text content in tool result");
  return JSON.parse(textBlock.text);
}

const MINI_SCHEMA = JSON.stringify({
  App: {
    entityTypes: {
      User: { memberOfTypes: [], shape: { type: "Record", attributes: { name: { type: "String", required: true } } } },
      Doc: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
    },
    actions: { read: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Doc"], context: { type: "Record", attributes: {} } } } },
  },
});

describe("e2e edge cases", () => {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  beforeEach(async () => {
    const conn = makeStdioClient();
    client = conn.client;
    transport = conn.transport;
    await client.connect(transport);
  });

  afterEach(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    client = undefined;
    transport = undefined;
  });

  it("EC1 — empty policy set: cedar_validate on whitespace-only text", async () => {
    // Boundary: zero policies, only whitespace. Cedar's parser must accept this
    // as a valid empty policy set (not an error). Failure case: a parser that
    // rejects whitespace-only input would break tools that diff an empty store
    // against a populated one.
    const result = parseToolResult(
      await client!.callTool({ name: "cedar_validate", arguments: { policies: "  \n\t  ", schema: MINI_SCHEMA } })
    ) as { valid: boolean; policy_count: number };
    expect(result.valid).toBe(true);
    expect(result.policy_count).toBe(0);
  }, 20_000);

  it("EC2 — single-policy set with no when/unless clauses", async () => {
    // Boundary: a permit with bare scope, no conditions. The simplest possible
    // non-empty policy. Failure case: a parser that requires at least one
    // condition clause would reject this even though Cedar accepts it.
    const policy = `permit (principal, action, resource);`;
    const result = parseToolResult(
      await client!.callTool({ name: "cedar_validate", arguments: { policies: policy, schema: MINI_SCHEMA } })
    ) as { valid: boolean; policy_count: number };
    expect(result.valid).toBe(true);
    expect(result.policy_count).toBe(1);
  }, 20_000);

  it("EC3 — forbid with unless guard (the inverse-permission pattern)", async () => {
    // Boundary: the classic 'top_secret unless admin' pattern. Tests that
    // forbid + unless composes correctly. Failure case: a generator/validator
    // that drops the unless clause would change the policy semantics.
    const policy = `forbid (principal, action, resource)
when { resource has classification && resource.classification == "top_secret" }
unless { principal in App::Role::"admin" };`;
    const schemaWithClassification = JSON.stringify({
      App: {
        entityTypes: {
          User: { memberOfTypes: ["Role"], shape: { type: "Record", attributes: {} } },
          Role: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
          Doc: { memberOfTypes: [], shape: { type: "Record", attributes: { classification: { type: "String", required: false } } } },
        },
        actions: { read: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Doc"], context: { type: "Record", attributes: {} } } } },
      },
    });
    const result = parseToolResult(
      await client!.callTool({ name: "cedar_validate", arguments: { policies: policy, schema: schemaWithClassification } })
    ) as { valid: boolean };
    expect(result.valid).toBe(true);
  }, 20_000);

  it("EC4 — very long entity id (1000 characters) is accepted", async () => {
    // Boundary: entity IDs near the upper end of practical use. Cedar's grammar
    // allows arbitrary string content in entity IDs; large IDs should not
    // crash the validator or the formatter.
    const longId = "x".repeat(1000);
    const policy = `permit (principal == App::User::"${longId}", action, resource);`;
    const result = parseToolResult(
      await client!.callTool({ name: "cedar_validate", arguments: { policies: policy, schema: MINI_SCHEMA } })
    ) as { valid: boolean };
    expect(result.valid).toBe(true);
  }, 20_000);

  it("EC5 — Unicode in attribute string values (validate + authorize)", async () => {
    // Boundary: non-ASCII string values in entity attributes. Cedar strings are
    // Unicode; the WASM boundary must handle UTF-8 without mangling.
    // Failure case: a transport layer treating the body as Latin-1 would corrupt
    // multi-byte characters.
    const entities = JSON.stringify([
      { uid: { type: "App::User", id: "u1" }, attrs: { name: "Ælfred Ø'Hára 日本語 🦀" }, parents: [] },
      { uid: { type: "App::Doc", id: "d1" }, attrs: {}, parents: [] },
    ]);
    const result = parseToolResult(
      await client!.callTool({
        name: "cedar_authorize",
        arguments: {
          policies: `permit (principal, action, resource) when { principal.name == "Ælfred Ø'Hára 日本語 🦀" };`,
          principal: 'App::User::"u1"',
          action: 'App::Action::"read"',
          resource: 'App::Doc::"d1"',
          entities,
          schema: MINI_SCHEMA,
        },
      })
    ) as { decision: string };
    expect(result.decision).toBe("Allow");
  }, 20_000);

  it("EC6 — cedar_authorize_batch on an empty requests array", async () => {
    // Boundary: zero requests. Should return total: 0, allowed: 0, denied: 0,
    // errored: 0 with a non-empty summary. Failure case: a divide-by-zero or
    // off-by-one in the summary computation.
    const result = parseToolResult(
      await client!.callTool({
        name: "cedar_authorize_batch",
        arguments: {
          policies: `permit (principal, action, resource);`,
          schema: MINI_SCHEMA,
          requests: "[]",
        },
      })
    ) as { total: number; allowed: number; denied: number; errored: number; summary: string };
    expect(result.total).toBe(0);
    expect(result.allowed).toBe(0);
    expect(result.denied).toBe(0);
    expect(result.errored).toBe(0);
    expect(result.summary.length).toBeGreaterThan(0);
  }, 20_000);

  it("EC7 — cedar_diff_schema across entirely different namespaces", async () => {
    // Boundary: blue and green share no namespaces. Diff should report blue's
    // namespace as removed and green's as added, with all entity_types and
    // actions classified accordingly. Failure case: a diff that only iterates
    // shared namespaces would miss this entirely.
    const blueSchema = JSON.stringify({ Foo: { entityTypes: { A: { memberOfTypes: [], shape: { type: "Record", attributes: {} } } }, actions: {} } });
    const greenSchema = JSON.stringify({ Bar: { entityTypes: { B: { memberOfTypes: [], shape: { type: "Record", attributes: {} } } }, actions: {} } });
    const result = parseToolResult(
      await client!.callTool({ name: "cedar_diff_schema", arguments: { blue: blueSchema, green: greenSchema } })
    ) as {
      namespaces_added: string[];
      namespaces_removed: string[];
      entity_types: { added: Array<{ namespace: string; name: string }>; removed: Array<{ namespace: string; name: string }> };
    };
    expect(result.namespaces_added).toContain("Bar");
    expect(result.namespaces_removed).toContain("Foo");
    expect(result.entity_types.added.find((e) => e.name === "B")).toBeDefined();
    expect(result.entity_types.removed.find((e) => e.name === "A")).toBeDefined();
  }, 20_000);

  it("EC8 — template with only ?principal slot (no ?resource slot)", async () => {
    // Boundary: a one-slot template. cedar_validate_template should detect
    // exactly one slot; cedar_link_template should accept just the principal arg.
    // Failure case: a template handler that requires both slots would reject
    // the link or produce malformed output.
    const template = `permit (principal == ?principal, action, resource);`;
    const validateResult = parseToolResult(
      await client!.callTool({ name: "cedar_validate_template", arguments: { template, schema: MINI_SCHEMA } })
    ) as { valid: boolean; slots?: string[]; detected_slots?: string[] };
    expect(validateResult.valid).toBe(true);

    const linkResult = parseToolResult(
      await client!.callTool({
        name: "cedar_link_template",
        arguments: { template, principal: 'App::User::"alice"', schema: MINI_SCHEMA },
      })
    ) as { linked_policy?: string; policy?: string };
    const linked = linkResult.linked_policy ?? linkResult.policy;
    expect(linked).toBeTruthy();
    expect(linked).toContain('App::User::"alice"');
    // The ?principal slot should be substituted; no remaining placeholder.
    expect(linked).not.toContain("?principal");
  }, 20_000);

  it("EC9 — cedar_validate_entities accepts a deeply-nested record attribute", async () => {
    // Boundary: a Record attribute containing another Record. Cedar supports
    // arbitrary nesting; the entities validator must walk recursively.
    // Failure case: a non-recursive validator that drops at depth 2.
    const schema = JSON.stringify({
      App: {
        entityTypes: {
          User: {
            memberOfTypes: [],
            shape: {
              type: "Record",
              attributes: {
                profile: {
                  type: "Record",
                  required: true,
                  attributes: {
                    name: { type: "String", required: true },
                    address: {
                      type: "Record",
                      required: true,
                      attributes: { city: { type: "String", required: true } },
                    },
                  },
                },
              },
            },
          },
        },
        actions: {},
      },
    });
    const entities = JSON.stringify([
      {
        uid: { type: "App::User", id: "u1" },
        attrs: {
          profile: {
            name: "Alice",
            address: { city: "Wroclaw" },
          },
        },
        parents: [],
      },
    ]);
    const result = parseToolResult(
      await client!.callTool({ name: "cedar_validate_entities", arguments: { entities, schema } })
    ) as { valid: boolean; errors: unknown[] };
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  }, 20_000);

  it("EC10 — cedar_authorize_batch with mixed Allow/Deny/Error outcomes in one batch", async () => {
    // Boundary: a batch where SOME requests succeed, SOME deny, and SOME error
    // out due to malformed entities. The batch must process all of them and
    // surface each in its respective category. Failure case: a batch that
    // aborts on the first error, losing visibility of later requests.
    const policy = `permit (principal in App::Role::"admin", action, resource);`;
    const schema = JSON.stringify({
      App: {
        entityTypes: {
          User: { memberOfTypes: ["Role"], shape: { type: "Record", attributes: { name: { type: "String", required: true } } } },
          Role: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
          Doc: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
        },
        actions: { read: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Doc"], context: { type: "Record", attributes: {} } } } },
      },
    });
    const requests = JSON.stringify([
      {
        principal: 'App::User::"alice"',
        action: 'App::Action::"read"',
        resource: 'App::Doc::"d1"',
        entities: JSON.stringify([
          { uid: { type: "App::User", id: "alice" }, attrs: { name: "Alice" }, parents: [{ type: "App::Role", id: "admin" }] },
          { uid: { type: "App::Role", id: "admin" }, attrs: {}, parents: [] },
          { uid: { type: "App::Doc", id: "d1" }, attrs: {}, parents: [] },
        ]),
      },
      {
        principal: 'App::User::"bob"',
        action: 'App::Action::"read"',
        resource: 'App::Doc::"d1"',
        entities: JSON.stringify([
          { uid: { type: "App::User", id: "bob" }, attrs: { name: "Bob" }, parents: [] },
          { uid: { type: "App::Doc", id: "d1" }, attrs: {}, parents: [] },
        ]),
      },
      {
        principal: 'App::User::"carol"',
        action: 'App::Action::"read"',
        resource: 'App::Doc::"d1"',
        entities: "{not valid json",  // malformed entities → Error
      },
    ]);
    const result = parseToolResult(
      await client!.callTool({ name: "cedar_authorize_batch", arguments: { policies: policy, schema, requests } })
    ) as { total: number; allowed: number; denied: number; errored: number; decisions: Array<{ index: number; decision: string }> };

    expect(result.total).toBe(3);
    expect(result.allowed).toBe(1);
    expect(result.denied + result.errored).toBe(2);  // bob denies; carol errors
    expect(result.decisions[0]?.decision).toBe("Allow");
    expect(result.decisions[2]?.decision).toBe("Error");
  }, 30_000);

  it("EC11 — policy_count handles 100 policies in a single text block", async () => {
    // Boundary: a large policy set passed as one text blob. Cedar's policy set
    // parser must scale linearly with input size, not blow up.
    // Failure case: O(n²) parser that hangs on 100 policies.
    const policies = Array.from({ length: 100 }, (_, i) =>
      `permit (principal in App::Role::"role-${i}", action, resource);`
    ).join("\n\n");
    const result = parseToolResult(
      await client!.callTool({
        name: "cedar_validate",
        arguments: { policies, schema: JSON.stringify({
          App: {
            entityTypes: {
              User: { memberOfTypes: ["Role"], shape: { type: "Record", attributes: {} } },
              Role: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
              Doc: { memberOfTypes: [], shape: { type: "Record", attributes: {} } },
            },
            actions: { read: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Doc"], context: { type: "Record", attributes: {} } } } },
          },
        })},
      })
    ) as { valid: boolean; policy_count: number };
    expect(result.valid).toBe(true);
    expect(result.policy_count).toBe(100);
  }, 20_000);
});
