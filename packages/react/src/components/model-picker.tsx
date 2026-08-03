import type { ClientModel } from "@opengeni/sdk";
import { ChevronDownIcon } from "lucide-react";
import { useId, useMemo } from "react";
import { groupPickerRowsByBillingClass, type PickerModelRow } from "../model-policy";
import { cn } from "../lib/cn";

export type ModelPickerProps = {
  /** Legacy host config models grouped by provider. */
  models?: ClientModel[] | undefined;
  /** Catalog-backed rows grouped by billing class. Preferred when available. */
  rows?: PickerModelRow[] | undefined;
  value?: string | undefined;
  onChange: (modelId: string) => void;
  disabled?: boolean | undefined;
  className?: string | undefined;
  label?: string | undefined;
  /**
   * When true (remote compaction v2), non-Codex models remain listed but are
   * disabled. Same picker chrome — only selectability changes.
   */
  codexOnly?: boolean | undefined;
};

const EMPTY_CLIENT_MODELS: ClientModel[] = [];

function isCodexClientModel(model: ClientModel): boolean {
  return model.id.startsWith("codex/") || model.source === "codex";
}

function isCodexPickerRow(row: PickerModelRow): boolean {
  return row.id.startsWith("codex/") || row.catalog.source === "codex";
}

function applyCodexOnlyRows(rows: PickerModelRow[], codexOnly: boolean): PickerModelRow[] {
  if (!codexOnly) return rows;
  return rows.map((row) => {
    if (isCodexPickerRow(row)) return row;
    return {
      ...row,
      selectable: false,
      unavailableReason: row.unavailableReason ?? "Codex-only session",
    };
  });
}

function providerGroups(models: ClientModel[], codexOnly: boolean) {
  const byProvider = new Map<
    string,
    { label: string; models: Array<ClientModel & { optionDisabled: boolean }> }
  >();
  for (const model of models) {
    let group = byProvider.get(model.provider);
    if (!group) {
      group = { label: model.providerLabel, models: [] };
      byProvider.set(model.provider, group);
    }
    group.models.push({
      ...model,
      optionDisabled: codexOnly && !isCodexClientModel(model),
    });
  }
  return [...byProvider.values()];
}

export function ModelPicker({
  models = EMPTY_CLIENT_MODELS,
  rows,
  value,
  onChange,
  disabled,
  className,
  label = "Model",
  codexOnly = false,
}: ModelPickerProps) {
  const selectId = useId();
  const effectiveRows = useMemo(
    () => (rows && rows.length > 0 ? applyCodexOnlyRows(rows, codexOnly) : []),
    [rows, codexOnly],
  );
  const billingGroups = useMemo(
    () => (effectiveRows.length > 0 ? groupPickerRowsByBillingClass(effectiveRows) : []),
    [effectiveRows],
  );
  const providerGroupList = useMemo(() => providerGroups(models, codexOnly), [models, codexOnly]);
  const useBillingGroups = Boolean(effectiveRows.length);

  if (models.length === 0 && effectiveRows.length === 0) {
    return null;
  }

  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <label htmlFor={selectId} className="sr-only">
        {label}
      </label>
      <select
        id={selectId}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled === true}
        aria-label={label}
        className={cn(
          "h-8 max-w-[180px] cursor-pointer appearance-none truncate rounded-og-md bg-transparent",
          "py-0 pl-2 pr-6 text-[13px] text-og-fg-muted",
          "transition-colors duration-150 hover:bg-og-surface-2 hover:text-og-fg",
          "focus:outline-none focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {useBillingGroups
          ? billingGroups.map((group) => (
              <optgroup key={group.billingClass} label={group.label}>
                {group.rows.map((row) => (
                  <option key={row.id} value={row.id} disabled={!row.selectable}>
                    {row.unavailableReason ? `${row.label} (${row.unavailableReason})` : row.label}
                  </option>
                ))}
              </optgroup>
            ))
          : providerGroupList.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.models.map((model) => (
                  <option key={model.id} value={model.id} disabled={model.optionDisabled}>
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
