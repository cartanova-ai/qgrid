import { type ModelCatalog } from "@/services/qgrid/qgrid.types";
import { QgridService } from "@/services/services.generated";

const PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["grok", "Grok"],
]);

/** Text models grouped by provider in catalog order. */
export function groupCatalogModels(
  text: ModelCatalog["text"],
): { label: string; models: string[] }[] {
  const groups = new Map<string, string[]>();

  for (const { id, provider } of text) groups.set(provider, [...(groups.get(provider) ?? []), id]);

  return [...groups].map(([provider, models]) => ({
    label: PROVIDER_LABELS.get(provider) ?? provider,
    models,
  }));
}

/**
 * `<option>`s for a text-model `<select>`, read from the server's models API so a new model needs
 * no dashboard change. The selected value stays listed while the catalog loads or if it is absent.
 */
export function ModelOptions({ selected }: { selected: string }) {
  const { data } = QgridService.useModels();
  const groups = groupCatalogModels(data?.text ?? []);
  const listed = groups.some((group) => group.models.includes(selected));

  return (
    <>
      {!listed && <option value={selected}>{selected}</option>}
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
