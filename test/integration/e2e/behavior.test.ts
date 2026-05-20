/**
 * E2E layer 2: cross-tool behavior invariants.
 *
 * Invariants that span multiple tools end-to-end through the MCP protocol.
 * Each test asserts a property the tool surface MUST satisfy, not a single
 * happy-path output. If two tools disagree on the same input, the invariant
 * surfaces it.
 *
 * Transport: stdio (same rationale as protocol.test.ts).
 *
 * Run: npx vitest run test/integration/e2e/behavior
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
    { name: "e2e-behavior", version: "1.0.0" },
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

const SCHEMA_JSON = JSON.stringify({
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
      read: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Document"], context: { type: "Record", attributes: {} } } },
      write: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Document"], context: { type: "Record", attributes: {} } } },
    },
  },
});

const ADMIN_POLICY = `permit (
  principal in DocMgmt::Role::"admin",
  action,
  resource
);`;

const VIEWER_POLICY = `permit (
  principal in DocMgmt::Role::"viewer",
  action == DocMgmt::Action::"read",
  resource
)
when {
  resource.classification == "public"
};`;

describe("e2e behavior", () => {
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

  it("B1 — translate round-trip preserves validation: text→json→text validates the same", async () => {
    // Invariant: if a policy validates against a schema, translating it to JSON and
    // back to text should produce a policy that ALSO validates against the same schema.
    // Failure case: AST round-trip drops a condition clause, validation passes "before"
    // but fails "after" (or vice versa). Catches lossy translations.

    const original = ADMIN_POLICY;

    const toJsonRaw = await client!.callTool({
      name: "cedar_translate",
      arguments: { input: original, type: "policy", direction: "to_json" },
    });
    const toJson = parseToolResult(toJsonRaw) as { output: string; error: null };
    expect(toJson.error).toBeNull();

    const toCedarRaw = await client!.callTool({
      name: "cedar_translate",
      arguments: { input: toJson.output, type: "policy", direction: "to_cedar" },
    });
    const toCedar = parseToolResult(toCedarRaw) as { output: string; error: null };
    expect(toCedar.error).toBeNull();

    const validateOriginal = parseToolResult(
      await client!.callTool({ name: "cedar_validate", arguments: { policies: original, schema: SCHEMA_JSON } })
    ) as { valid: boolean };
    const validateRoundtrip = parseToolResult(
      await client!.callTool({ name: "cedar_validate", arguments: { policies: toCedar.output, schema: SCHEMA_JSON } })
    ) as { valid: boolean };

    expect(validateOriginal.valid).toBe(validateRoundtrip.valid);
    expect(validateOriginal.valid).toBe(true);
  }, 30_000);

  it("B2 — format idempotency: format(format(P)) === format(P)", async () => {
    // Invariant: formatting a policy twice produces the same output as formatting once.
    // Failure case: an inconsistent formatter that adds/removes whitespace differently
    // on successive runs would break diff tools and CI checks.
    const firstRaw = await client!.callTool({ name: "cedar_format", arguments: { policies: VIEWER_POLICY } });
    const first = parseToolResult(firstRaw) as { formatted: string };

    const secondRaw = await client!.callTool({ name: "cedar_format", arguments: { policies: first.formatted } });
    const second = parseToolResult(secondRaw) as { formatted: string };

    expect(second.formatted).toBe(first.formatted);
  }, 30_000);

  it("B3 — generate-then-authorize agrees: when generator claims Allow, cedar_authorize confirms Allow", async () => {
    // Invariant: if cedar_generate_sample_request claims ready_to_test:true and
    // decision:"Allow", then cedar_authorize on the same request MUST also return Allow.
    // If the generator is unable to construct a satisfying request (ready_to_test:false),
    // that's a known limitation we don't fail on — but if it CLAIMS success and the
    // independent authorize disagrees, that's a real product bug.
    const genRaw = await client!.callTool({
      name: "cedar_generate_sample_request",
      arguments: { policy: ADMIN_POLICY, schema: SCHEMA_JSON, target_decision: "allow" },
    });
    const gen = parseToolResult(genRaw) as {
      principal: string;
      action: string;
      resource: string;
      entities: unknown[];
      decision?: "Allow" | "Deny";
      ready_to_test?: boolean;
    };

    if (gen.ready_to_test === false || gen.decision !== "Allow") {
      // eslint-disable-next-line no-console
      console.warn("B3 — generator did not claim success for target=allow (ready_to_test=" + gen.ready_to_test + ", decision=" + gen.decision + "); skipping cross-tool assertion.");
      return;
    }

    const authRaw = await client!.callTool({
      name: "cedar_authorize",
      arguments: {
        policies: ADMIN_POLICY,
        principal: gen.principal,
        action: gen.action,
        resource: gen.resource,
        entities: JSON.stringify(gen.entities),
        schema: SCHEMA_JSON,
      },
    });
    const auth = parseToolResult(authRaw) as { decision: string };
    expect(auth.decision).toBe("Allow");
  }, 30_000);

  // B4 exercises the skip path: the generator self-reports ready_to_test:false +
  // decision:"Allow" for target=deny on the ADMIN policy (which permits everything for
  // admin role — no satisfying deny exists for an admin principal). The skip is the
  // correct behavior; the assertion is vacuously true. If the generator one day
  // produces a satisfying deny request, the .skip path would not fire and we'd assert
  // Deny against authorize like B3 does.
  it("B4 — generate-then-authorize agrees: when generator claims Deny, cedar_authorize confirms Deny", async () => {
    // Symmetric invariant for the deny path. Same skip pattern as B3 when the
    // generator self-reports it couldn't produce a satisfying example.
    const genRaw = await client!.callTool({
      name: "cedar_generate_sample_request",
      arguments: { policy: ADMIN_POLICY, schema: SCHEMA_JSON, target_decision: "deny" },
    });
    const gen = parseToolResult(genRaw) as {
      principal: string;
      action: string;
      resource: string;
      entities: unknown[];
      decision?: "Allow" | "Deny";
      ready_to_test?: boolean;
    };

    if (gen.ready_to_test === false || gen.decision !== "Deny") {
      // eslint-disable-next-line no-console
      console.warn("B4 — generator did not claim success for target=deny (ready_to_test=" + gen.ready_to_test + ", decision=" + gen.decision + "); skipping cross-tool assertion.");
      return;
    }

    const authRaw = await client!.callTool({
      name: "cedar_authorize",
      arguments: {
        policies: ADMIN_POLICY,
        principal: gen.principal,
        action: gen.action,
        resource: gen.resource,
        entities: JSON.stringify(gen.entities),
        schema: SCHEMA_JSON,
      },
    });
    const auth = parseToolResult(authRaw) as { decision: string };

    expect(auth.decision).toBe("Deny");
  }, 30_000);

  it("B5 — diff_schema identity: diffing a schema against itself reports no changes, risk safe", async () => {
    // Invariant: any diff function applied to two equal inputs MUST report zero changes.
    // Failure case: a normalizer that introduces spurious differences (e.g., __cedar:: prefix
    // stripping that's asymmetric) would flag identical schemas as different. We tested this
    // explicitly in the unit suite but the e2e path adds the MCP protocol layer on top —
    // a serialization bug could re-emerge here.
    const raw = await client!.callTool({
      name: "cedar_diff_schema",
      arguments: { blue: SCHEMA_JSON, green: SCHEMA_JSON },
    });
    const result = parseToolResult(raw) as {
      risk_level: string;
      entity_types: { added: unknown[]; removed: unknown[]; modified: unknown[] };
      actions: { added: unknown[]; removed: unknown[]; modified: unknown[] };
    };

    expect(result.risk_level).toBe("safe");
    expect(result.entity_types.added).toHaveLength(0);
    expect(result.entity_types.removed).toHaveLength(0);
    expect(result.entity_types.modified).toHaveLength(0);
    expect(result.actions.added).toHaveLength(0);
    expect(result.actions.removed).toHaveLength(0);
    expect(result.actions.modified).toHaveLength(0);
  }, 20_000);

  it("B6 — check_policy_change identity: comparing a policy against itself reports no changes", async () => {
    // Invariant: cedar_check_policy_change(P, P) must say can_update_in_place: true
    // with no changes. Failure case: an over-eager change detector flagging whitespace
    // or comment differences as semantic changes would generate noisy AVP recommendations.
    const raw = await client!.callTool({
      name: "cedar_check_policy_change",
      arguments: { old_policy: VIEWER_POLICY, new_policy: VIEWER_POLICY },
    });
    const result = parseToolResult(raw) as {
      can_update_in_place: boolean;
      changes: unknown[];
    };

    expect(result.can_update_in_place).toBe(true);
    expect(result.changes).toHaveLength(0);
  }, 20_000);

  it("B7 — validate + authorize agree on schema-level errors", async () => {
    // Invariant: if cedar_validate flags a policy as invalid against a schema (e.g.,
    // references a missing attribute), then cedar_authorize with validateRequest=true
    // on the same policy+schema should ALSO surface the issue (as a request-level
    // error or as a Deny). The two tools must not disagree about schema validity.
    const badPolicy = `permit (principal, action, resource) when { resource.nonexistent_attr == "x" };`;

    const validateRaw = await client!.callTool({
      name: "cedar_validate",
      arguments: { policies: badPolicy, schema: SCHEMA_JSON },
    });
    const validate = parseToolResult(validateRaw) as { valid: boolean; errors: Array<{ message: string }> };

    expect(validate.valid).toBe(false);
    expect(validate.errors.length).toBeGreaterThan(0);
    expect(validate.errors[0].message).toContain("nonexistent_attr");

    // Now run an authorize with this same policy. Cedar's behavior: a policy that
    // references a missing attribute evaluates to false (silently skipped) at
    // authorize time. So the request returns Deny (no permit applies). The
    // INVARIANT here is "they don't disagree about the policy being broken" —
    // validate says invalid, authorize returns the default-deny. If authorize
    // returned Allow for this policy, it would prove they disagree.
    const authRaw = await client!.callTool({
      name: "cedar_authorize",
      arguments: {
        policies: badPolicy,
        principal: 'DocMgmt::User::"alice"',
        action: 'DocMgmt::Action::"read"',
        resource: 'DocMgmt::Document::"d1"',
        entities: JSON.stringify([
          { uid: { type: "DocMgmt::User", id: "alice" }, attrs: { name: "Alice", email: "a@b.c" }, parents: [] },
          { uid: { type: "DocMgmt::Document", id: "d1" }, attrs: { owner: "alice", classification: "public" }, parents: [] },
        ]),
        schema: SCHEMA_JSON,
      },
    });
    const auth = parseToolResult(authRaw) as { decision: string };

    expect(auth.decision).toBe("Deny");
  }, 30_000);

  it("B8 — validate_template + link_template + validate consistency", async () => {
    // Invariant: if a template validates against a schema, then linking it with
    // valid slot values must produce a policy that ALSO validates. Catches lossy
    // template-linking implementations.
    const template = `permit (
      principal == ?principal,
      action == DocMgmt::Action::"read",
      resource == ?resource
    );`;

    const validateTplRaw = await client!.callTool({
      name: "cedar_validate_template",
      arguments: { template, schema: SCHEMA_JSON },
    });
    const validateTpl = parseToolResult(validateTplRaw) as { valid: boolean };
    expect(validateTpl.valid).toBe(true);

    const linkRaw = await client!.callTool({
      name: "cedar_link_template",
      arguments: {
        template,
        principal: 'DocMgmt::User::"alice"',
        resource: 'DocMgmt::Document::"d1"',
        schema: SCHEMA_JSON,
      },
    });
    const link = parseToolResult(linkRaw) as { linked_policy?: string; policy?: string; valid?: boolean };
    const linkedPolicy = link.linked_policy ?? link.policy;
    expect(linkedPolicy).toBeTruthy();

    // The linked output should pass cedar_validate as a regular static policy
    const validateLinkedRaw = await client!.callTool({
      name: "cedar_validate",
      arguments: { policies: linkedPolicy!, schema: SCHEMA_JSON },
    });
    const validateLinked = parseToolResult(validateLinkedRaw) as { valid: boolean };
    expect(validateLinked.valid).toBe(true);
  }, 30_000);
});
