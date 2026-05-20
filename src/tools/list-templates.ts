import { templateToJson } from "@cedar-policy/cedar-wasm/nodejs";
import type { PolicyJson } from "@cedar-policy/cedar-wasm/nodejs";
import { storeManager, StoreManager } from "../resources/store-manager.js";

export interface ListTemplatesInput {
  store: string;
}

export interface TemplateEntry {
  id: string;
  content: string;
  slots: string[];
}

export interface ListTemplatesResult {
  store: string;
  templates: TemplateEntry[];
  error?: string;
}

function detectSlots(json: PolicyJson): string[] {
  const slots: string[] = [];
  const p = json.principal as Record<string, unknown>;
  const r = json.resource as Record<string, unknown>;
  if (p?.slot === "?principal") slots.push("?principal");
  if (r?.slot === "?resource") slots.push("?resource");
  return slots;
}

export async function handleListTemplates(
  input: ListTemplatesInput,
  manager: StoreManager = storeManager
): Promise<ListTemplatesResult> {
  let ids: string[];
  try {
    ids = manager.listTemplates(input.store);
  } catch (e) {
    return { store: input.store, templates: [], error: e instanceof Error ? e.message : String(e) };
  }

  const templates: TemplateEntry[] = [];
  for (const id of ids) {
    const content = manager.readTemplate(input.store, id);
    const parsed = templateToJson(content);
    const slots = parsed.type === "success" ? detectSlots(parsed.json as PolicyJson) : [];
    templates.push({ id, content, slots });
  }

  return { store: input.store, templates };
}
