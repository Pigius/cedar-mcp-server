import { schemaToText, schemaToJsonWithResolvedTypes } from "@cedar-policy/cedar-wasm/nodejs";

export interface DiffSchemaInput {
  blue: string;
  green: string;
}

type Risk = "safe" | "review" | "breaking";

export interface AttributeChange {
  attr: string;
  change: "added" | "removed" | "type_changed" | "optional_to_required" | "required_to_optional";
  old_type?: string;
  new_type?: string;
  risk: Risk;
  reason: string;
}

export interface EntityTypeModification {
  namespace: string;
  name: string;
  member_of_changes?: { added: string[]; removed: string[]; risk: Risk; reason: string };
  attribute_changes?: AttributeChange[];
}

export interface ContextChange {
  attr: string;
  change: "added" | "removed" | "type_changed";
  old_type?: string;
  new_type?: string;
  risk: Risk;
  reason: string;
}

export interface ActionModification {
  namespace: string;
  name: string;
  principal_types?: { added: string[]; removed: string[]; risk: Risk; reason: string };
  resource_types?: { added: string[]; removed: string[]; risk: Risk; reason: string };
  context_changes?: ContextChange[];
}

export interface SchemaDiff {
  namespaces_added: string[];
  namespaces_removed: string[];
  entity_types: {
    added: Array<{ namespace: string; name: string }>;
    removed: Array<{ namespace: string; name: string; risk: Risk; reason: string }>;
    modified: EntityTypeModification[];
  };
  actions: {
    added: Array<{ namespace: string; name: string }>;
    removed: Array<{ namespace: string; name: string; risk: Risk; reason: string }>;
    modified: ActionModification[];
  };
  common_types: {
    added: Array<{ namespace: string; name: string }>;
    removed: Array<{ namespace: string; name: string; risk: Risk; reason: string }>;
    modified: Array<{ namespace: string; name: string; risk: Risk; reason: string }>;
  };
  summary: string;
  risk_level: Risk;
  error?: string;
}

interface CanonicalSchema {
  [ns: string]: {
    entityTypes?: Record<string, CanonicalEntityType>;
    actions?: Record<string, CanonicalAction>;
    commonTypes?: Record<string, unknown>;
  };
}

interface CanonicalEntityType {
  memberOfTypes?: string[];
  shape?: { type: string; attributes?: Record<string, CanonicalAttr> };
}

interface CanonicalAttr {
  type: string;
  required?: boolean;
}

interface CanonicalAction {
  appliesTo?: {
    principalTypes?: string[];
    resourceTypes?: string[];
    context?: { type: string; attributes?: Record<string, CanonicalAttr> };
  };
}

function stripCedarPrefix(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/^__cedar::/, "");
  if (Array.isArray(value)) return value.map(stripCedarPrefix);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === "type" && typeof v === "string" ? v.replace(/^__cedar::/, "") : stripCedarPrefix(v);
    }
    return out;
  }
  return value;
}

function normalizeToCanonical(schemaStr: string): CanonicalSchema {
  let asText: string;

  // 1. Detect JSON vs cedarschema text
  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(schemaStr);
  } catch {
    parsedJson = null;
  }

  if (parsedJson !== null && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
    const textAns = schemaToText(parsedJson as never);
    if (textAns.type !== "success") {
      throw new Error("Failed to convert JSON schema to text form: " + (textAns.errors?.[0]?.message ?? "unknown error"));
    }
    asText = textAns.text;
  } else {
    asText = schemaStr;
  }

  // 2. Always normalize via schemaToJsonWithResolvedTypes (text input only — per spike findings)
  const ans = schemaToJsonWithResolvedTypes(asText);
  if (ans.type !== "success") {
    throw new Error("Failed to parse schema: " + (ans.errors?.[0]?.message ?? "unknown error"));
  }

  return stripCedarPrefix(ans.json) as CanonicalSchema;
}

function attrType(attr: CanonicalAttr | undefined): string {
  if (!attr) return "unknown";
  return attr.type;
}

function attrRequired(attr: CanonicalAttr): boolean {
  return attr.required !== false;
}

function setDiff<T>(blue: T[], green: T[]): { added: T[]; removed: T[] } {
  const blueSet = new Set(blue);
  const greenSet = new Set(green);
  return {
    added: green.filter((x) => !blueSet.has(x)),
    removed: blue.filter((x) => !greenSet.has(x)),
  };
}

function diffAttributes(
  blueAttrs: Record<string, CanonicalAttr> | undefined,
  greenAttrs: Record<string, CanonicalAttr> | undefined,
  contextLabel: "attribute" | "context attribute"
): AttributeChange[] {
  const b = blueAttrs ?? {};
  const g = greenAttrs ?? {};
  const changes: AttributeChange[] = [];

  for (const [name, gAttr] of Object.entries(g)) {
    if (!(name in b)) {
      const required = attrRequired(gAttr);
      changes.push({
        attr: name,
        change: "added",
        new_type: attrType(gAttr),
        risk: required ? "breaking" : "safe",
        reason: required
          ? `Required ${contextLabel} added: existing entities/requests without this field will fail validation.`
          : `Optional ${contextLabel} added: existing policies do not reference it; safe to deploy.`,
      });
    }
  }

  for (const [name, bAttr] of Object.entries(b)) {
    if (!(name in g)) {
      changes.push({
        attr: name,
        change: "removed",
        old_type: attrType(bAttr),
        risk: "breaking",
        reason: `${contextLabel[0].toUpperCase() + contextLabel.slice(1)} removed: policies referencing it will fail validation.`,
      });
      continue;
    }
    const gAttr = g[name];
    if (attrType(bAttr) !== attrType(gAttr)) {
      changes.push({
        attr: name,
        change: "type_changed",
        old_type: attrType(bAttr),
        new_type: attrType(gAttr),
        risk: "breaking",
        reason: `Type changed (${attrType(bAttr)} → ${attrType(gAttr)}): policies expecting the old type will fail evaluation.`,
      });
      continue;
    }
    const bReq = attrRequired(bAttr);
    const gReq = attrRequired(gAttr);
    if (bReq !== gReq) {
      changes.push({
        attr: name,
        change: bReq ? "required_to_optional" : "optional_to_required",
        risk: bReq ? "safe" : "breaking",
        reason: bReq
          ? "Required → optional: all existing entities still satisfy the constraint."
          : "Optional → required: existing entities without the field will fail validation.",
      });
    }
  }

  return changes;
}

function diffEntityTypes(
  blue: CanonicalSchema,
  green: CanonicalSchema,
  diff: SchemaDiff,
  removedNamespaces: Set<string>,
  addedNamespaces: Set<string>
): void {
  const allNamespaces = new Set([...Object.keys(blue), ...Object.keys(green)]);
  for (const ns of allNamespaces) {
    const bEnts = blue[ns]?.entityTypes ?? {};
    const gEnts = green[ns]?.entityTypes ?? {};

    for (const [name, gEnt] of Object.entries(gEnts)) {
      if (!(name in bEnts)) {
        diff.entity_types.added.push({ namespace: ns, name });
      } else {
        const bEnt = bEnts[name];
        const mod: EntityTypeModification = { namespace: ns, name };

        const bMember = bEnt.memberOfTypes ?? [];
        const gMember = gEnt.memberOfTypes ?? [];
        const memberD = setDiff(bMember, gMember);
        if (memberD.added.length > 0 || memberD.removed.length > 0) {
          const breaking = memberD.removed.length > 0;
          mod.member_of_changes = {
            added: memberD.added,
            removed: memberD.removed,
            risk: breaking ? "breaking" : "review",
            reason: breaking
              ? "Parent types removed: policies using `in` against removed parents will fail validation."
              : "Parent types added: hierarchy widened; policies using `in` may match more entities than before.",
          };
        }

        const attrChanges = diffAttributes(
          bEnt.shape?.attributes,
          gEnt.shape?.attributes,
          "attribute"
        );
        if (attrChanges.length > 0) mod.attribute_changes = attrChanges;

        if (mod.member_of_changes || mod.attribute_changes) {
          diff.entity_types.modified.push(mod);
        }
      }
    }

    for (const [name, bEnt] of Object.entries(bEnts)) {
      if (!(name in gEnts)) {
        diff.entity_types.removed.push({
          namespace: ns,
          name,
          risk: "breaking",
          reason: removedNamespaces.has(ns)
            ? `Namespace ${ns} removed; entity type removed transitively. Policies referencing it will fail.`
            : "Entity type removed: policies referencing it will fail validation; runtime requests for it will fail.",
        });
        void bEnt;
      }
    }
    void addedNamespaces;
  }
}

function diffActions(
  blue: CanonicalSchema,
  green: CanonicalSchema,
  diff: SchemaDiff
): void {
  const allNamespaces = new Set([...Object.keys(blue), ...Object.keys(green)]);
  for (const ns of allNamespaces) {
    const bActs = blue[ns]?.actions ?? {};
    const gActs = green[ns]?.actions ?? {};

    for (const [name, gAct] of Object.entries(gActs)) {
      if (!(name in bActs)) {
        diff.actions.added.push({ namespace: ns, name });
      } else {
        const bAct = bActs[name];
        const mod: ActionModification = { namespace: ns, name };

        const bPrin = bAct.appliesTo?.principalTypes ?? [];
        const gPrin = gAct.appliesTo?.principalTypes ?? [];
        const prinD = setDiff(bPrin, gPrin);
        if (prinD.added.length > 0 || prinD.removed.length > 0) {
          const breaking = prinD.removed.length > 0;
          mod.principal_types = {
            added: prinD.added,
            removed: prinD.removed,
            risk: breaking ? "breaking" : "review",
            reason: breaking
              ? "Principal types narrowed: existing policies for the removed type will fail validation."
              : "Principal types widened: action applies to more principal types; policy effect may change.",
          };
        }

        const bRes = bAct.appliesTo?.resourceTypes ?? [];
        const gRes = gAct.appliesTo?.resourceTypes ?? [];
        const resD = setDiff(bRes, gRes);
        if (resD.added.length > 0 || resD.removed.length > 0) {
          const breaking = resD.removed.length > 0;
          mod.resource_types = {
            added: resD.added,
            removed: resD.removed,
            risk: breaking ? "breaking" : "review",
            reason: breaking
              ? "Resource types narrowed: existing policies for the removed type will fail validation."
              : "Resource types widened: action applies to more resource types; policy effect may change.",
          };
        }

        const ctxChanges = diffAttributes(
          bAct.appliesTo?.context?.attributes,
          gAct.appliesTo?.context?.attributes,
          "context attribute"
        );
        if (ctxChanges.length > 0) {
          mod.context_changes = ctxChanges.map((c) => ({
            attr: c.attr,
            change: c.change as ContextChange["change"],
            ...(c.old_type !== undefined ? { old_type: c.old_type } : {}),
            ...(c.new_type !== undefined ? { new_type: c.new_type } : {}),
            risk: c.risk,
            reason: c.reason,
          }));
        }

        if (mod.principal_types || mod.resource_types || mod.context_changes) {
          diff.actions.modified.push(mod);
        }
      }
    }

    for (const name of Object.keys(bActs)) {
      if (!(name in gActs)) {
        diff.actions.removed.push({
          namespace: ns,
          name,
          risk: "breaking",
          reason: "Action removed: policies referencing it become invalid; runtime requests for it will fail.",
        });
      }
    }
  }
}

function diffCommonTypes(
  blue: CanonicalSchema,
  green: CanonicalSchema,
  diff: SchemaDiff
): void {
  const allNamespaces = new Set([...Object.keys(blue), ...Object.keys(green)]);
  for (const ns of allNamespaces) {
    const bCt = blue[ns]?.commonTypes ?? {};
    const gCt = green[ns]?.commonTypes ?? {};

    for (const name of Object.keys(gCt)) {
      if (!(name in bCt)) diff.common_types.added.push({ namespace: ns, name });
    }
    for (const name of Object.keys(bCt)) {
      if (!(name in gCt)) {
        diff.common_types.removed.push({
          namespace: ns,
          name,
          risk: "review",
          reason: "Common type removed: if referenced by any entity/action, policies will fail validation. Audit usages.",
        });
      } else if (JSON.stringify(bCt[name]) !== JSON.stringify(gCt[name])) {
        diff.common_types.modified.push({
          namespace: ns,
          name,
          risk: "review",
          reason: "Common type definition changed: review every entity/action that references it.",
        });
      }
    }
  }
}

function computeRiskLevel(diff: SchemaDiff): Risk {
  const allRisks: Risk[] = [];
  diff.entity_types.removed.forEach((e) => allRisks.push(e.risk));
  diff.entity_types.modified.forEach((m) => {
    if (m.member_of_changes) allRisks.push(m.member_of_changes.risk);
    m.attribute_changes?.forEach((c) => allRisks.push(c.risk));
  });
  diff.actions.removed.forEach((a) => allRisks.push(a.risk));
  diff.actions.modified.forEach((m) => {
    if (m.principal_types) allRisks.push(m.principal_types.risk);
    if (m.resource_types) allRisks.push(m.resource_types.risk);
    m.context_changes?.forEach((c) => allRisks.push(c.risk));
  });
  diff.common_types.removed.forEach((c) => allRisks.push(c.risk));
  diff.common_types.modified.forEach((c) => allRisks.push(c.risk));

  if (allRisks.includes("breaking")) return "breaking";
  if (allRisks.includes("review")) return "review";
  return "safe";
}

function computeSummary(diff: SchemaDiff): string {
  const parts: string[] = [];
  const breakingCount =
    diff.entity_types.removed.length +
    diff.actions.removed.length +
    diff.entity_types.modified.reduce((acc, m) => {
      const memberBreaking = m.member_of_changes?.risk === "breaking" ? 1 : 0;
      const attrsBreaking = (m.attribute_changes ?? []).filter((c) => c.risk === "breaking").length;
      return acc + memberBreaking + attrsBreaking;
    }, 0) +
    diff.actions.modified.reduce((acc, m) => {
      const pBreak = m.principal_types?.risk === "breaking" ? 1 : 0;
      const rBreak = m.resource_types?.risk === "breaking" ? 1 : 0;
      const cBreak = (m.context_changes ?? []).filter((c) => c.risk === "breaking").length;
      return acc + pBreak + rBreak + cBreak;
    }, 0);

  if (diff.namespaces_added.length) parts.push(`${diff.namespaces_added.length} namespace(s) added`);
  if (diff.namespaces_removed.length) parts.push(`${diff.namespaces_removed.length} namespace(s) removed`);
  if (diff.entity_types.added.length) parts.push(`${diff.entity_types.added.length} entity type(s) added`);
  if (diff.entity_types.removed.length) parts.push(`${diff.entity_types.removed.length} entity type(s) removed`);
  if (diff.entity_types.modified.length) parts.push(`${diff.entity_types.modified.length} entity type(s) modified`);
  if (diff.actions.added.length) parts.push(`${diff.actions.added.length} action(s) added`);
  if (diff.actions.removed.length) parts.push(`${diff.actions.removed.length} action(s) removed`);
  if (diff.actions.modified.length) parts.push(`${diff.actions.modified.length} action(s) modified`);
  if (diff.common_types.added.length) parts.push(`${diff.common_types.added.length} common type(s) added`);
  if (diff.common_types.removed.length) parts.push(`${diff.common_types.removed.length} common type(s) removed`);
  if (diff.common_types.modified.length) parts.push(`${diff.common_types.modified.length} common type(s) modified`);

  if (parts.length === 0) return "No schema changes detected.";

  const breaking = breakingCount > 0 ? ` (${breakingCount} BREAKING)` : "";
  return `Schema diff: ${parts.join(", ")}${breaking}.`;
}

export async function handleDiffSchema(input: DiffSchemaInput): Promise<SchemaDiff> {
  let blueJson: CanonicalSchema;
  let greenJson: CanonicalSchema;

  try {
    blueJson = normalizeToCanonical(input.blue);
  } catch (e) {
    return errorResult(`blue schema: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    greenJson = normalizeToCanonical(input.green);
  } catch (e) {
    return errorResult(`green schema: ${e instanceof Error ? e.message : String(e)}`);
  }

  const diff: SchemaDiff = {
    namespaces_added: [],
    namespaces_removed: [],
    entity_types: { added: [], removed: [], modified: [] },
    actions: { added: [], removed: [], modified: [] },
    common_types: { added: [], removed: [], modified: [] },
    summary: "",
    risk_level: "safe",
  };

  const blueNs = new Set(Object.keys(blueJson));
  const greenNs = new Set(Object.keys(greenJson));
  for (const ns of greenNs) if (!blueNs.has(ns)) diff.namespaces_added.push(ns);
  for (const ns of blueNs) if (!greenNs.has(ns)) diff.namespaces_removed.push(ns);

  diffEntityTypes(
    blueJson,
    greenJson,
    diff,
    new Set(diff.namespaces_removed),
    new Set(diff.namespaces_added)
  );
  diffActions(blueJson, greenJson, diff);
  diffCommonTypes(blueJson, greenJson, diff);

  diff.summary = computeSummary(diff);
  diff.risk_level = computeRiskLevel(diff);

  return diff;
}

function errorResult(error: string): SchemaDiff {
  return {
    namespaces_added: [],
    namespaces_removed: [],
    entity_types: { added: [], removed: [], modified: [] },
    actions: { added: [], removed: [], modified: [] },
    common_types: { added: [], removed: [], modified: [] },
    summary: "",
    risk_level: "safe",
    error,
  };
}
