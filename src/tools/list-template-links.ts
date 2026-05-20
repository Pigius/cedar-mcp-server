import { storeManager, StoreManager } from "../resources/store-manager.js";

export interface ListTemplateLinksInput {
  store: string;
}

export interface TemplateLinkEntry {
  id: string;
  template_id: string;
  slot_values: Record<string, string>;
}

export interface ListTemplateLinksResult {
  store: string;
  links: TemplateLinkEntry[];
  error?: string;
}

export async function handleListTemplateLinks(
  input: ListTemplateLinksInput,
  manager: StoreManager = storeManager
): Promise<ListTemplateLinksResult> {
  let ids: string[];
  try {
    ids = manager.listTemplateLinks(input.store);
  } catch (e) {
    return { store: input.store, links: [], error: e instanceof Error ? e.message : String(e) };
  }

  const links: TemplateLinkEntry[] = [];
  for (const id of ids) {
    try {
      const data = manager.readTemplateLink(input.store, id);
      links.push({ id, template_id: data.template_id, slot_values: data.slot_values });
    } catch (e) {
      return { store: input.store, links, error: `Failed to read link "${id}": ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  return { store: input.store, links };
}
