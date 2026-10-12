import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { SearchIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { TextInput } from "@/components/ui/field";

/* ----------------------------------------------------------------------------
   One list of a workspace's models, grouped by who serves them, for the
   per-model form pages under Models (Allowed models, Context & compaction).
   -------------------------------------------------------------------------- */

/** At this many models the list gets a search field. */
export const MODEL_LIST_SEARCH_AT = 9;

/** Models grouped by provider label, providers and models in name order. */
export function groupModelsByProvider<
  T extends Pick<WorkspaceModelCatalogModel, "label" | "providerLabel">,
>(models: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const model of [...models].sort((left, right) => {
    const provider = left.providerLabel.localeCompare(right.providerLabel);
    return provider === 0 ? left.label.localeCompare(right.label) : provider;
  })) {
    const group = groups.get(model.providerLabel) ?? [];
    group.push(model);
    groups.set(model.providerLabel, group);
  }
  return [...groups.entries()];
}

/** The groups whose models match every word of the query, by name, ID or provider. */
export function filterModelGroups<T extends Pick<WorkspaceModelCatalogModel, "id" | "label">>(
  groups: readonly [string, T[]][],
  query: string,
): [string, T[]][] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return groups
    .map(
      ([label, models]) =>
        [
          label,
          models.filter((model) =>
            words.every((word) =>
              `${model.label} ${model.id} ${label}`.toLocaleLowerCase().includes(word),
            ),
          ),
        ] as [string, T[]],
    )
    .filter(([, models]) => models.length > 0);
}

export function ModelSearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative block min-w-0">
      <span className="sr-only">Search models</span>
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle"
      />
      <TextInput
        type="search"
        value={value}
        placeholder="Search models"
        suppressAutofill
        onChange={(event) => onChange(event.target.value)}
        className="pl-9"
      />
    </label>
  );
}

/** A provider's models: a small heading over a divided list of rows. */
export function ModelGroup({
  label,
  meta,
  control,
  children,
}: {
  label: string;
  /** Muted text after the name, such as who pays for the group's models. */
  meta?: string | undefined;
  /** A control for the whole group, aligned with the row controls. */
  control?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="flex min-w-0 items-center gap-3 pb-1">
        <h3 id={id} className="min-w-0 flex-1 truncate text-xs leading-4.5 font-medium text-fg">
          {label}
          {meta ? <span className="font-normal text-fg-muted"> · {meta}</span> : null}
        </h3>
        {control}
      </div>
      <ul className="m-0 flex min-w-0 list-none flex-col divide-y divide-border p-0">{children}</ul>
    </section>
  );
}
