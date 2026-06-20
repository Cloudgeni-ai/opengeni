import type { ClientModel } from "@opengeni/sdk";
import { ChevronDownIcon } from "lucide-react";
import { useId, useMemo } from "react";
import { cn } from "../lib/cn";

export type ModelPickerProps = {
  /** The host-exposed models to choose from (typically {@link useAvailableModels}). */
  models: ClientModel[];
  /** Controlled selection — the model id, or undefined for "nothing chosen yet". */
  value?: string | undefined;
  /** Called with the chosen model id when the operator picks a row. */
  onChange: (modelId: string) => void;
  disabled?: boolean | undefined;
  className?: string | undefined;
};

/**
 * The model picker — a compact dropdown for the composer footer, grouping the
 * host-exposed models by `providerLabel` (so "OpenAI" and "Fireworks AI" head
 * their own sections) and showing each model's display `label`. A native
 * `<select>` keeps it keyboard- and screen-reader-accessible for free and
 * themes via the package's og-* tokens; the chevron is a decorative overlay.
 *
 * Controlled: the host owns `value`/`onChange` and threads the selection into
 * the send path. Renders nothing when no models are exposed, so a single-model
 * deployment shows no chrome.
 */
export function ModelPicker({ models, value, onChange, disabled, className }: ModelPickerProps) {
  const selectId = useId();
  // Group by provider, preserving first-seen order for both the providers and
  // the models within each — the server already orders the list (default model
  // and built-in provider first), so we must not re-sort it.
  const groups = useMemo(() => {
    const byProvider = new Map<string, { label: string; models: ClientModel[] }>();
    for (const model of models) {
      let group = byProvider.get(model.provider);
      if (!group) {
        group = { label: model.providerLabel, models: [] };
        byProvider.set(model.provider, group);
      }
      group.models.push(model);
    }
    return [...byProvider.values()];
  }, [models]);

  if (models.length === 0) {
    return null;
  }

  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <label htmlFor={selectId} className="sr-only">
        Model
      </label>
      <select
        id={selectId}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled === true}
        aria-label="Model"
        className={cn(
          // Sized like the other footer controls; the chevron overlay needs the
          // right padding so the value never collides with it.
          "h-8 max-w-[180px] cursor-pointer appearance-none truncate rounded-og-md bg-transparent",
          "py-0 pl-2 pr-6 text-[13px] text-og-fg-muted",
          "transition-colors duration-150 hover:bg-og-surface-2 hover:text-og-fg",
          "focus:outline-none focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDownIcon
        aria-hidden
        className="pointer-events-none absolute right-1.5 size-3.5 text-og-fg-subtle"
      />
    </span>
  );
}
