import { useMemo, useState, type ReactNode } from "react";

import { Button } from "../../ui/button";
import { ChoiceCard, ChoiceCards } from "../../ui/choice-cards";
import { CheckboxField } from "../../ui/field";
import { Skeleton } from "../../ui/skeleton";
import { Toolbar, ToolbarSearch } from "../../ui/toolbar";

/* ----------------------------------------------------------------------------
   "Available in": where a thing can be used, in the same words for every kind
   (model accounts, vaults, bots, and whatever else an organization or a
   workspace shares). One owner per thing decides who manages it; where it
   works never changes that owner, so the control says both:

     Available in
     Belongs to Acme. Organization owners and admins manage it.
     ( ) All workspaces in Acme         every shared workspace, new ones too
     ( ) Selected workspaces            only the ones ticked below
     [x] Personal workspaces            organization things only

   A workspace's own thing always works in that workspace (its row stays
   ticked); your own thing always works in your Personal workspace. Your own
   logins, plans and machines use per-workspace switches that save at once
   instead ("Where it works"), because each one changes your own turns only.
   -------------------------------------------------------------------------- */

export type WorkspaceReach = {
  /** The workspaces it works in; null for every workspace, including new ones. */
  workspaceIds: readonly string[] | null;
  /** Organization things only: whether members can use it in their own Personal workspace. */
  personalWorkspaces: boolean;
};

export type ReachWorkspace = {
  id: string;
  name: string;
  /** The viewer's own Personal workspace, listed like the others. */
  personal?: boolean | undefined;
};

/** Who owns a thing, and so who manages it. */
export type ReachOwner =
  | { kind: "organization"; name: string }
  | { kind: "workspace"; id: string; name: string }
  | { kind: "person" };

/**
 * How Personal workspaces are handled: one checkbox for everyone's
 * (organization things), always included (your own things), or not offered.
 */
export type ReachPersonalWorkspaces = "choice" | "always" | "none";

/**
 * "Belongs to Acme. Organization owners manage it." Who manages a kind differs
 * (vaults and bots need organization owners, model accounts owners and admins),
 * so the caller says it; your own things are managed by you alone.
 */
export function reachOwnerLine(owner: ReachOwner, managedBy?: string): string {
  const belongs = owner.kind === "person" ? "Belongs to you." : `Belongs to ${owner.name}.`;
  const manager = managedBy ?? (owner.kind === "person" ? "Only you manage it." : undefined);
  return manager ? `${belongs} ${manager}` : belongs;
}

function workspaceCount(count: number): string {
  return count === 1 ? "1 workspace" : `${count} workspaces`;
}

/**
 * The short value for an "Available in" row: "All workspaces + Personal",
 * "2 workspaces", "Personal workspaces only", "All my workspaces". Workspaces
 * that always have it (`alwaysIncluded`) count.
 */
export function workspaceReachSummary(
  reach: WorkspaceReach,
  input: {
    owner: ReachOwner["kind"];
    personalWorkspaces: ReachPersonalWorkspaces;
    alwaysIncluded?: readonly string[] | undefined;
  },
): string {
  if (input.owner === "person") {
    if (reach.workspaceIds === null) return "All my workspaces";
    const count = reach.workspaceIds.length;
    return count === 0 ? "Only Personal" : `Personal + ${workspaceCount(count)}`;
  }
  const personal = input.personalWorkspaces === "choice" && reach.personalWorkspaces;
  const count =
    reach.workspaceIds === null
      ? null
      : new Set([...reach.workspaceIds, ...(input.alwaysIncluded ?? [])]).size;
  if (count === 0) return personal ? "Personal workspaces only" : "No workspaces";
  const shared = count === null ? "All workspaces" : workspaceCount(count);
  return personal ? `${shared} + Personal` : shared;
}

/** Nothing can use it as drafted: no workspace ticked and no Personal workspaces. */
export function workspaceReachIsEmpty(
  reach: WorkspaceReach,
  input: {
    owner: ReachOwner["kind"];
    personalWorkspaces: ReachPersonalWorkspaces;
    alwaysIncluded?: readonly string[] | undefined;
  },
): boolean {
  if (input.owner !== "organization") return false;
  return (
    reach.workspaceIds !== null &&
    reach.workspaceIds.length === 0 &&
    (input.alwaysIncluded ?? []).length === 0 &&
    !(input.personalWorkspaces === "choice" && reach.personalWorkspaces)
  );
}

function toggle(values: readonly string[], value: string, checked: boolean): string[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

/**
 * Workspaces to tick, with their loading, failed, empty and long-list states.
 * Rows in `alwaysIncluded` stay ticked with their reason; the workspace the
 * page was opened from says so.
 */
export function WorkspaceChecklist({
  legend = "Workspaces",
  workspaces,
  workspacesError = false,
  onRetryWorkspaces,
  selected,
  onSelectedChange,
  hereId,
  alwaysIncluded,
  emptyText = "This organization has no shared workspaces yet.",
  disabled = false,
  error,
}: {
  legend?: string;
  /** null while loading. */
  workspaces: readonly ReachWorkspace[] | null;
  workspacesError?: boolean;
  onRetryWorkspaces?: (() => void) | undefined;
  selected: readonly string[];
  onSelectedChange: (next: string[]) => void;
  /** The workspace the page was opened from. */
  hereId?: string | null | undefined;
  /** Workspace id to the reason it is always included. */
  alwaysIncluded?: Readonly<Record<string, string>> | undefined;
  emptyText?: string;
  disabled?: boolean;
  error?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase();
  const long = (workspaces?.length ?? 0) > 8;
  const shown = useMemo(
    () =>
      (workspaces ?? []).filter(
        (workspace) => !words || workspace.name.toLowerCase().includes(words),
      ),
    [workspaces, words],
  );
  const ticked = workspaces
    ? workspaces.filter(
        (workspace) =>
          alwaysIncluded?.[workspace.id] !== undefined || selected.includes(workspace.id),
      ).length
    : 0;
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="mb-2 p-0 text-xs leading-4.5 font-medium text-fg">{legend}</legend>
      {workspaces === null && workspacesError ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <p className="m-0 text-sm leading-5 text-fg-muted">
            Couldn't load the organization's workspaces.
          </p>
          {onRetryWorkspaces ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetryWorkspaces}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : workspaces === null ? (
        <div aria-busy="true" aria-label="Loading workspaces" className="flex flex-col gap-3">
          <Skeleton className="h-5 w-48 rounded-md" />
          <Skeleton className="h-5 w-36 rounded-md" />
        </div>
      ) : workspaces.length === 0 ? (
        <p className="m-0 text-sm leading-5 text-fg-muted">{emptyText}</p>
      ) : (
        <>
          {long ? (
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
          <div
            className={
              long
                ? "-mx-1 flex max-h-80 min-w-0 flex-col gap-3 overflow-y-auto px-1 py-0.5"
                : "flex min-w-0 flex-col gap-3"
            }
          >
            {shown.map((workspace) => {
              const name = workspace.personal ? "Your Personal workspace" : workspace.name;
              const label = workspace.id === hereId ? `${name} (this workspace)` : name;
              const reason = alwaysIncluded?.[workspace.id];
              return reason !== undefined ? (
                <CheckboxField
                  key={workspace.id}
                  label={label}
                  disabledReason={reason}
                  disabled
                  checked
                />
              ) : (
                <CheckboxField
                  key={workspace.id}
                  label={label}
                  disabled={disabled}
                  checked={selected.includes(workspace.id)}
                  onCheckedChange={(checked) =>
                    onSelectedChange(toggle(selected, workspace.id, checked))
                  }
                />
              );
            })}
            {shown.length === 0 ? (
              <p className="m-0 text-sm leading-5 text-fg-muted">No workspaces match.</p>
            ) : null}
          </div>
          {long ? (
            <p className="m-0 text-xs leading-4.5 text-fg-muted">
              {ticked} of {workspaces.length} selected
            </p>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="m-0 text-sm leading-5 text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * Another way to limit it, beside the workspace choices, such as "Only
 * selected people" for a model account. While chosen it replaces the
 * workspace list and the Personal workspaces choice.
 */
export type ReachExtraChoice = {
  value: string;
  title: string;
  description: string;
  chosen: boolean;
  onChoose: () => void;
  /** Shown under the choices while it is chosen. */
  content?: ReactNode;
};

/**
 * The "Available in" control: the owner line, all or selected workspaces, the
 * workspace list, and for organization things the Personal workspaces choice.
 */
export function WorkspaceReachFields({
  owner,
  organizationName,
  managedBy,
  showOwner = true,
  label = "Available in",
  labelHidden = false,
  value,
  onChange,
  workspaces,
  workspacesError = false,
  onRetryWorkspaces,
  hereId,
  alwaysIncluded,
  personalWorkspaces,
  seedSelected,
  extraChoice,
  emptyText,
  error,
  disabled = false,
}: {
  owner: ReachOwner;
  organizationName: string;
  /** Who manages it, as a sentence: "Organization owners manage it." */
  managedBy?: string | undefined;
  /** Off where the owner was chosen right above, so it isn't said twice. */
  showOwner?: boolean;
  label?: string;
  /** On a page whose title already says it; the group keeps it as its name. */
  labelHidden?: boolean;
  value: WorkspaceReach;
  onChange: (next: WorkspaceReach) => void;
  /** The workspaces it could reach; null while loading. */
  workspaces: readonly ReachWorkspace[] | null;
  workspacesError?: boolean;
  onRetryWorkspaces?: (() => void) | undefined;
  hereId?: string | null | undefined;
  /** Workspace id to the reason it is always included (its owner, or one that keeps it). */
  alwaysIncluded?: Readonly<Record<string, string>> | undefined;
  personalWorkspaces: ReachPersonalWorkspaces;
  /** The workspaces ticked when switching to Selected workspaces. None by default. */
  seedSelected?: (() => string[]) | undefined;
  extraChoice?: ReachExtraChoice | undefined;
  emptyText?: string | undefined;
  error?: ReactNode;
  disabled?: boolean;
}) {
  const person = owner.kind === "person";
  const home = owner.kind === "workspace" ? owner : null;
  const included = useMemo(
    () =>
      home
        ? { [home.id]: "It belongs to this workspace, so it's always included.", ...alwaysIncluded }
        : alwaysIncluded,
    [home, alwaysIncluded],
  );
  const listed = useMemo(
    () =>
      // Your own thing always works in your Personal workspace: no row for it.
      person ? (workspaces?.filter((workspace) => !workspace.personal) ?? null) : workspaces,
    [person, workspaces],
  );
  const mode = extraChoice?.chosen
    ? extraChoice.value
    : value.workspaceIds === null
      ? "all"
      : "selected";
  const ownerLine = showOwner ? reachOwnerLine(owner, managedBy) : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ChoiceCards
        {...(labelHidden ? { "aria-label": label } : { label })}
        description={ownerLine}
        value={mode}
        disabled={disabled}
        onValueChange={(next) => {
          if (extraChoice && next === extraChoice.value) {
            extraChoice.onChoose();
            return;
          }
          onChange({
            ...value,
            workspaceIds: next === "all" ? null : (seedSelected?.() ?? []),
          });
        }}
      >
        <ChoiceCard
          value="all"
          title={person ? "All my workspaces" : `All workspaces in ${organizationName}`}
          description={
            person
              ? `Every workspace you use in ${organizationName}, including new ones.`
              : "Every shared workspace, including new ones."
          }
        />
        <ChoiceCard
          value="selected"
          title="Selected workspaces"
          description={
            person
              ? "Your Personal workspace and the workspaces you pick."
              : home
                ? `${home.name} and the workspaces you pick. Workspaces added later aren't included.`
                : "Only the workspaces you pick. Workspaces added later aren't included."
          }
        />
        {extraChoice ? (
          <ChoiceCard
            value={extraChoice.value}
            title={extraChoice.title}
            description={extraChoice.description}
          />
        ) : null}
      </ChoiceCards>
      {extraChoice?.chosen ? (
        extraChoice.content
      ) : value.workspaceIds !== null ? (
        <WorkspaceChecklist
          legend={personalWorkspaces === "choice" ? "Shared workspaces" : "Workspaces"}
          workspaces={listed}
          workspacesError={workspacesError}
          onRetryWorkspaces={onRetryWorkspaces}
          selected={value.workspaceIds}
          onSelectedChange={(workspaceIds) => onChange({ ...value, workspaceIds })}
          hereId={hereId}
          alwaysIncluded={included}
          {...(emptyText
            ? { emptyText }
            : person
              ? { emptyText: "You have no other workspaces in this organization." }
              : {})}
          disabled={disabled}
          error={error}
        />
      ) : error ? (
        <p role="alert" className="m-0 text-sm leading-5 text-danger">
          {error}
        </p>
      ) : null}
      {personalWorkspaces === "choice" && !extraChoice?.chosen ? (
        <div className="mt-2 border-t border-border pt-4">
          <CheckboxField
            label="Personal workspaces"
            description="Members can use it in their own Personal workspace."
            disabled={disabled}
            checked={value.personalWorkspaces}
            onCheckedChange={(checked) => onChange({ ...value, personalWorkspaces: checked })}
          />
        </div>
      ) : null}
    </div>
  );
}
