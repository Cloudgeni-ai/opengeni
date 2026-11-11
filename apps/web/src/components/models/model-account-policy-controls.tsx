import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAppContext } from "@opengeni/react/app/app-context";
import { Button } from "@opengeni/react/ui/button";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { ModelPicker } from "@opengeni/react/app/components/pickers";

/** Edit one exact preferred-model mapping. Never infer model equivalence. */
export function FallbackOrderControl({
  order,
  modelLabel,
  disabled = false,
  saving,
  onSave,
  onReset,
}: {
  order: Record<string, string[]>;
  modelLabel: (id: string) => string;
  disabled?: boolean;
  saving: boolean;
  onSave: (model: string, fallbackIds: string[]) => Promise<void>;
  onReset?: ((model: string) => Promise<void>) | undefined;
}) {
  const catalog = useAppContext().clientConfig?.models ?? [];
  const labels = new Map(catalog.map((model) => [model.id, model.label]));
  const ids = [
    ...new Set([
      ...catalog.map((model) => model.id),
      ...Object.keys(order),
      ...Object.values(order).flat(),
    ]),
  ];
  const label = (id: string) => labels.get(id) ?? modelLabel(id);
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState(Object.keys(order)[0] ?? ids[0] ?? "");
  const [draft, setDraft] = useState<string[]>(order[model] ?? []);
  const saved = JSON.stringify(order[model] ?? []);
  useEffect(() => setDraft(JSON.parse(saved) as string[]), [model, saved]);
  const busy = disabled || saving;
  const move = (index: number, delta: number) =>
    setDraft((previous) => {
      const next = [...previous];
      [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
      return next;
    });
  if (!editing)
    return (
      <RowButton disabled={busy} onClick={() => setEditing(true)}>
        Edit order
      </RowButton>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <span className="text-xs text-fg-muted">Preferred model</span>
      <ModelPicker
        models={catalog}
        model={model}
        effort="none"
        latencyMode="standard"
        disabled={busy}
        triggerStyle="field"
        allowLatencyMode={false}
        allowModelOptions={false}
        collapseScopes={false}
        onModelChange={setModel}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />
      <ol aria-label="Fallback order" className="m-0 list-none space-y-2 p-0">
        {draft.map((id, index) => (
          <li key={id} className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-sm" title={label(id)}>
              {index + 1}. {label(id)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Move ${label(id)} up`}
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Move ${label(id)} down`}
              disabled={busy || index === draft.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDownIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${label(id)}`}
              disabled={busy}
              onClick={() => setDraft((previous) => previous.filter((each) => each !== id))}
            >
              <XIcon className="size-4" />
            </Button>
          </li>
        ))}
      </ol>
      {draft.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">No fallback for this model.</p>
      ) : null}
      <span className="text-xs text-fg-muted">Add a fallback model</span>
      <ModelPicker
        models={catalog.filter((entry) => entry.id !== model && !draft.includes(entry.id))}
        model=""
        effort="none"
        latencyMode="standard"
        disabled={busy || !model}
        triggerStyle="field"
        allowLatencyMode={false}
        allowModelOptions={false}
        collapseScopes={false}
        onModelChange={(id) =>
          setDraft((previous) =>
            previous.includes(id) || id === model ? previous : [...previous, id],
          )
        }
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />
      <div className="flex flex-wrap items-center gap-2">
        <RowButton
          disabled={
            busy || !model || (Object.hasOwn(order, model) && JSON.stringify(draft) === saved)
          }
          onClick={() => void onSave(model, draft)}
        >
          Save order
        </RowButton>
        {onReset ? (
          <RowButton disabled={busy || !model} onClick={() => void onReset(model)}>
            Use organization order
          </RowButton>
        ) : null}
        <RowButton
          disabled={saving}
          onClick={() => {
            setDraft(JSON.parse(saved) as string[]);
            setEditing(false);
          }}
        >
          Close
        </RowButton>
      </div>
    </div>
  );
}
