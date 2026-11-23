import { QgridService } from "@/services/services.generated";

const PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["grok", "Grok"],
]);

/**
 * `<option>`s for a text-model `<select>`, read from the server's models API so a new model needs
 * no dashboard change. The selected value stays listed while the catalog loads or if it is absent.
 */
export function ModelOptions({ selected }: { selected: string }) {
  const text = QgridService.useModels().data?.text ?? [];
  const groups = Map.groupBy(text, (m) => m.provider);

  return (
    <>
      {!text.some((m) => m.id === selected) && <option value={selected}>{selected}</option>}
      {[...groups].map(([provider, models]) => (
        <optgroup key={provider} label={PROVIDER_LABELS.get(provider) ?? provider}>
          {models.map(({ id }) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
