import type { VaultAvailability } from "@opengeni/react";
import { useMemo, useState } from "react";

import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Checkbox, CheckboxField } from "@/components/ui/field";
import { Toolbar, ToolbarSearch } from "@/components/ui/toolbar";

/* ----------------------------------------------------------------------------
   "Available in" (S6): which workspaces can use a vault. For an organization
   vault: all of the organization's workspaces (new ones too) or a selection,
   plus whether Personal workspaces may use it. For an Only-me vault: every
   workspace its owner uses or a selection; their Personal workspace always
   has it.
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

/** The Only-me default: the workspace it is added from, or only Personal from there. */
export function personalAvailabilityFrom(currentWorkspaceId: string | null): VaultAvailability {
  return {
    allowedWorkspaceIds: currentWorkspaceId ? [currentWorkspaceId] : [],
    allowPersonalWorkspaces: true,
  };
}

export function AvailabilityEditor({
  value,
  onChange,
  workspaces,
  organizationName,
  error,
  labelHidden = false,
  personal = false,
}: {
  value: VaultAvailability;
  onChange: (value: VaultAvailability) => void;
  /** The organization's shared workspaces (for an Only-me vault, the owner's). */
  workspaces: AvailabilityWorkspace[];
  organizationName: string;
  error?: string | undefined;
  /** On the Available in page the title already says it; name the group for screen readers only. */
  labelHidden?: boolean;
  /** An Only-me vault: always in its owner's Personal workspace, never in anyone else's. */
  personal?: boolean;
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
        {...(labelHidden ? { "aria-label": "Available in" } : { label: "Available in" })}
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
          title={personal ? "All my workspaces" : "All workspaces"}
          description={
            personal
              ? `Every workspace you use in ${organizationName}, including new ones.`
              : `Every workspace in ${organizationName}, including new ones.`
          }
        />
        <ChoiceCard
          value="selected"
          title="Selected workspaces"
          description={
            personal
              ? "Your Personal workspace and the workspaces you pick."
              : "Only the workspaces you pick."
          }
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
              <li className="px-2.5 py-2 text-sm text-fg-muted">
                {workspaces.length === 0 ? "You have no other workspaces." : "No workspaces match."}
              </li>
            ) : null}
          </ul>
          <p className="m-0 text-xs leading-4.5 text-fg-muted">
            {personal
              ? selected.size === 0
                ? "Only your Personal workspace"
                : `Personal and ${selected.size} of ${workspaces.length} selected`
              : `${selected.size} of ${workspaces.length} selected`}
          </p>
        </div>
      ) : null}
      {personal ? null : (
        <CheckboxField
          label="Include personal workspaces"
          description="People can use it in their own Personal workspace."
          checked={value.allowPersonalWorkspaces}
          onCheckedChange={(next) => onChange({ ...value, allowPersonalWorkspaces: next })}
        />
      )}
    </div>
  );
}
