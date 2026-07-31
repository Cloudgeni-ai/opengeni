import type { ClientModel } from "@opengeni/sdk";
import { ChevronDownIcon } from "lucide-react";
import { useId, useMemo } from "react";
import {
  groupPickerRowsByBillingClass,
  type PickerModelRow,
} from "../model-policy";
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
};

function providerGroups(models: ClientModel[]) {
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
}

export function ModelPicker({
  models = [],
  rows,
  value,
  onChange,
  disabled,
  className,
  label = "Model",
}: ModelPickerProps) {
  const selectId = useId();
  const billingGroups = useMemo(
    () => (rows && rows.length > 0 ? groupPickerRowsByBillingClass(rows) : []),
    [rows],
  );
  const providerGroupList = useMemo(() => providerGroups(models), [models]);
  const useBillingGroups = Boolean(rows?.length);

  if (models.length === 0 && (!rows || rows.length === 0)) {
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
