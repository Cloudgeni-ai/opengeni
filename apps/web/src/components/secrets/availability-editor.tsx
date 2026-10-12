import type { VaultAvailability } from "@opengeni/react";
import { useMemo, useState } from "react";

import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Checkbox, CheckboxField } from "@/components/ui/field";
import { Toolbar, ToolbarSearch } from "@/components/ui/toolbar";

/* ----------------------------------------------------------------------------
   "Available in" (S6): which workspaces of the organization can use an
   organization vault. All (new ones too) or a selection, plus whether
   Personal workspaces may use it.
   -------------------------------------------------------------------------- */

export type AvailabilityWorkspace = { id: string; name: string };

export const DEFAULT_AVAILABILITY: VaultAvailability = {
  allowedWorkspaceIds: null,
  allowPersonalWorkspaces: true,
};

export function availabilitySummary(
  availability: VaultAvailability,
  workspaces: AvailabilityWorkspace[],
): string {
  if (availability.allowedWorkspaceIds === null) return "All workspaces";
  const count = availability.allowedWorkspaceIds.length;
  return `${count} of ${workspaces.length} workspaces`;
}

export function AvailabilityEditor({
  value,
  onChange,
  workspaces,
  organizationName,
  error,
}: {
  value: VaultAvailability;
  onChange: (value: VaultAvailability) => void;
  /** The organization's shared workspaces. */
  workspaces: AvailabilityWorkspace[];
  organizationName: string;
  error?: string | undefined;
}) {
  const [query, setQuery] = useState("");
  const selected = new Set(value.allowedWorkspaceIds ?? []);
  const words = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      workspaces
        .filter((workspace) => !words || workspace.name.toLowerCase().includes(words))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [workspaces, words],
  );
  const mode = value.allowedWorkspaceIds === null ? "all" : "selected";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ChoiceCards
        variant="radio"
        label="Available in"
        value={mode}
        error={error}
        onValueChange={(next) =>
          onChange({
            ...value,
            allowedWorkspaceIds: next === "all" ? null : [...selected],
          })
        }
      >
        <ChoiceCard
          value="all"
          title="All workspaces"
          description={`Every workspace in ${organizationName}, including new ones.`}
        />
        <ChoiceCard
          value="selected"
          title="Selected workspaces"
          description="Only the workspaces you pick."
        />
      </ChoiceCards>
      {mode === "selected" ? (
        <div className="flex min-w-0 flex-col gap-2 pl-7 max-sm:pl-0">
          {workspaces.length > 8 ? (
            <Toolbar>
              <ToolbarSearch
                value={query}
                onValueChange={setQuery}
                placeholder="Search workspaces"
                aria-label="Search workspaces"
                wrapperClassName="min-w-0 flex-1"
              />
            </Toolbar>
          ) : null}
          <ul
            aria-label="Workspaces"
            className="m-0 flex max-h-80 min-w-0 list-none flex-col overflow-y-auto rounded-[10px] border border-border p-1"
          >
            {shown.map((workspace) => {
              const checked = selected.has(workspace.id);
              return (
                <li key={workspace.id}>
                  <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-[8px] px-2.5 text-sm leading-5 text-fg hover:bg-hover">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) => {
                        const ids = new Set(selected);
                        if (next) ids.add(workspace.id);
                        else ids.delete(workspace.id);
                        onChange({ ...value, allowedWorkspaceIds: [...ids] });
                      }}
                    />
                    <span className="min-w-0 truncate">{workspace.name}</span>
                  </label>
                </li>
              );
            })}
            {shown.length === 0 ? (
              <li className="px-2.5 py-2 text-sm text-fg-muted">No workspaces match.</li>
            ) : null}
          </ul>
          <p className="m-0 text-xs leading-4.5 text-fg-muted">
            {selected.size} of {workspaces.length} selected
          </p>
        </div>
      ) : null}
      <CheckboxField
        label="Include personal workspaces"
        description="People can use it in their own Personal workspace."
        checked={value.allowPersonalWorkspaces}
        onCheckedChange={(next) => onChange({ ...value, allowPersonalWorkspaces: next })}
      />
    </div>
  );
}
