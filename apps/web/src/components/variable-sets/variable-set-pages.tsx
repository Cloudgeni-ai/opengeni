import { useState } from "react";
import {
  BoxIcon,
  Building2Icon,
  CalendarClockIcon,
  ContainerIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  UserIcon,
  VariableIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { InlineHelp } from "@/components/ui/inline-help";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@/components/ui/line-tabs";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { SecretValue } from "@/components/ui/secret-field";
import { Section, SectionStack } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import type { WorkspaceVariableSet } from "@/types";

import { AddVariableRow, type NewVariableInput } from "./variable-set-forms";
import {
  SCOPE_LABEL,
  errorParts,
  joinAnd,
  scopeChip,
  usageParts,
  usageSummary,
  variablesLabel,
  type UsageEntry,
  type VariableSetScope,
  type VariableSetUsage,
} from "./variable-set-model";
import { MoreMenu } from "@/components/ui/page-actions";

/* ----------------------------------------------------------------------------
   /variable-sets: one borderless list, the whole row opens the set's own
   page. Sets are grouped by who can use them only when more than one kind
   exists. /variable-sets/$id: the set's page with Variables | Used by tabs
   and a quiet aside card.
   -------------------------------------------------------------------------- */

export const VARIABLE_SETS_DESCRIPTION =
  "Environment variables and secrets your agents get in their sandbox.";

const LIST_COLUMNS: RowListColumn[] = [
  { id: "variables", label: "Variables", width: 88, hideLabel: true },
  { id: "usage", label: "Used by", width: 152, hideLabel: true },
  { id: "updated", label: "Updated", width: 96, hideLabel: true },
];

const GROUPS: { scope: VariableSetScope; title: string; description?: (org: string) => string }[] =
  [
    { scope: "workspace", title: "This workspace" },
    {
      scope: "user",
      title: "Only me",
      description: () => "Private to you. Only work you start gets these values.",
    },
    {
      scope: "organization",
      title: "Organization",
      description: (org) =>
        `Shared with every workspace in ${org}. Organization admins manage them.`,
    },
  ];

export type ListState = "loading" | "error" | "ready";

export function LoadFailure({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  const parts = errorParts(error);
  return (
    <ErrorMessage
      variant="block"
      align="center"
      title={title}
      reference={parts.reference}
      details={[
        ...(parts.status ? [{ label: "Status", value: String(parts.status) }] : []),
        { label: "Message", value: parts.message },
      ]}
      action={
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RotateCcwIcon aria-hidden="true" />
          Try again
        </Button>
      }
    >
      Check your connection, then try again. Your sets and values are safe.
    </ErrorMessage>
  );
}

function UsageCell({ usage }: { usage: VariableSetUsage }) {
  if (!usage.known) return <span className="text-fg-subtle">Checking use…</span>;
  const parts = usageParts(usage.entries);
  const [first, ...rest] = parts;
  if (!first) return <>Not used</>;
  if (rest.length === 0) return <>Used by {first}</>;
  const tail = rest.length === 1 ? `and ${rest[0]}` : joinAnd(rest);
  return (
    <>
      <span className="@[640px]/list:block @[640px]/list:truncate">
        Used by {first}
        {rest.length > 1 ? "," : ""}
      </span>{" "}
      <span className="@[640px]/list:block @[640px]/list:truncate">{tail}</span>
    </>
  );
}

export function ScopeChip({ scope }: { scope: VariableSetScope }) {
  const label = scopeChip(scope);
  return label ? <MetaChip>{label}</MetaChip> : null;
}

export function VariableSetsListPage({
  state,
  error,
  sets,
  usageFor,
  organizationName,
  canCreate,
  canList,
  onRetry,
  onOpenSet,
  onNewSet,
}: {
  state: ListState;
  error: unknown;
  sets: WorkspaceVariableSet[];
  usageFor: (set: WorkspaceVariableSet) => VariableSetUsage;
  organizationName: string;
  canCreate: boolean;
  canList: boolean;
  onRetry: () => void;
  onOpenSet: (set: WorkspaceVariableSet) => void;
  onNewSet: () => void;
}) {
  const empty = state === "ready" && sets.length === 0;
  const newSetButton = (
    <Button type="button" onClick={onNewSet} className="pointer-coarse:h-11">
      <PlusIcon aria-hidden="true" />
      New variable set
    </Button>
  );

  const renderRow = (set: WorkspaceVariableSet, grouped: boolean) => (
    <ListRow
      key={set.id}
      leading={<LogoTile icon={<VariableIcon />} />}
      title={set.name}
      titleAddon={grouped ? null : <ScopeChip scope={set.scope} />}
      description={set.description || undefined}
      cells={{
        variables: variablesLabel(set),
        usage: <UsageCell usage={usageFor(set)} />,
        updated: <RelativeTime date={set.updatedAt} />,
      }}
      indicator="open"
      onOpen={() => onOpenSet(set)}
    />
  );

  let body;
  if (!canList) {
    body = (
      <EmptyState
        variant="page"
        icon={<VariableIcon />}
        title="You can't see variable sets here"
        description="Ask a workspace admin for access to variable sets."
      />
    );
  } else if (state === "loading") {
    body = (
      <RowList label="Variable sets" columns={LIST_COLUMNS} flush busy>
        <ListRowSkeleton count={3} />
      </RowList>
    );
  } else if (state === "error") {
    body = <LoadFailure title="Couldn't load variable sets" error={error} onRetry={onRetry} />;
  } else if (empty) {
    body = (
      <EmptyState
        variant="page"
        icon={<VariableIcon />}
        title="No variable sets yet"
        description={
          canCreate
            ? "Give agents API keys and config as environment variables, without pasting them into chat."
            : "Someone who can manage variable sets can add one here."
        }
        action={canCreate ? newSetButton : undefined}
      />
    );
  } else {
    const scopes = new Set(sets.map((set) => set.scope));
    const grouped = scopes.size > 1;
    body = grouped ? (
      <SectionStack>
        {GROUPS.map((group) => {
          const rows = sets.filter((set) => set.scope === group.scope);
          if (rows.length === 0) return null;
          return (
            <Section
              key={group.scope}
              title={
                <>
                  {group.title}
                  <span className="ml-2 font-normal text-fg-subtle tabular-nums">
                    {rows.length}
                  </span>
                </>
              }
              description={group.description?.(organizationName)}
            >
              <RowList label={`Variable sets: ${group.title}`} columns={LIST_COLUMNS} flush>
                {rows.map((set) => renderRow(set, true))}
              </RowList>
            </Section>
          );
        })}
      </SectionStack>
    ) : (
      <RowList label="Variable sets" columns={LIST_COLUMNS} flush>
        {sets.map((set) => renderRow(set, false))}
      </RowList>
    );
  }

  return (
    <div className="min-w-0">
      <PageHeader
        title="Variable sets"
        description={VARIABLE_SETS_DESCRIPTION}
        actions={canCreate && canList && !empty ? newSetButton : undefined}
      />
      <div className="min-w-0 pt-6">{body}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The set's own page.
   -------------------------------------------------------------------------- */

export interface VariableSetPageActions {
  back: () => void;
  /** Saves one variable from the inline row. Throws a user-facing error. */
  addVariable: (variable: NewVariableInput) => Promise<void>;
  /** Opens the Paste .env page. */
  pasteEnv: () => void;
  replaceValue: (name: string) => void;
  deleteVariable: (name: string) => void;
  editSet: () => void;
  deleteSet: () => void;
  openUsage: (entry: UsageEntry) => void;
}

const USAGE_ICON = {
  schedule: CalendarClockIcon,
  chat: MessageSquareIcon,
  environment: ContainerIcon,
} as const;

const SCOPE_ICON = {
  workspace: <BoxIcon />,
  organization: <Building2Icon />,
  user: <UserIcon />,
} as const;

const VARIABLE_COLUMNS: RowListColumn[] = [
  { id: "value", label: "Value", width: 160, hideLabel: true },
  { id: "updated", label: "Updated", width: 120 },
];

function SetMenu({
  set,
  canEdit,
  canDelete,
  actions,
}: {
  set: WorkspaceVariableSet;
  canEdit: boolean;
  canDelete: boolean;
  actions: VariableSetPageActions;
}) {
  if (!canEdit && !canDelete) return null;
  return (
    <MoreMenu label={`More actions for ${set.name}`}>
      {canEdit ? (
        <DropdownMenuItem onSelect={actions.editSet}>
          <PencilIcon aria-hidden="true" />
          Edit details
        </DropdownMenuItem>
      ) : null}
      {canEdit && canDelete ? <DropdownMenuSeparator /> : null}
      {canDelete ? (
        <DropdownMenuItem variant="destructive" onSelect={actions.deleteSet}>
          <Trash2Icon aria-hidden="true" />
          Delete variable set
        </DropdownMenuItem>
      ) : null}
    </MoreMenu>
  );
}

function VariablesTable({
  set,
  canManage,
  actions,
}: {
  set: WorkspaceVariableSet;
  canManage: boolean;
  actions: VariableSetPageActions;
}) {
  return (
    <RowList variant="table" label={`Variables in ${set.name}`} columns={VARIABLE_COLUMNS}>
      {set.variables.map((variable) => (
        <ListRow
          key={variable.name}
          title={<span className="font-mono text-xs leading-5 break-all">{variable.name}</span>}
          cells={{
            value: <SecretValue kind="secret" name={variable.name} />,
            updated: <RelativeTime date={variable.updatedAt} inSentence className="text-xs" />,
          }}
          menuLabel={`Actions for ${variable.name}`}
          menu={
            canManage ? (
              <>
                <DropdownMenuItem onSelect={() => actions.replaceValue(variable.name)}>
                  <PencilIcon aria-hidden="true" />
                  Replace value
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => actions.deleteVariable(variable.name)}
                >
                  <Trash2Icon aria-hidden="true" />
                  Delete
                </DropdownMenuItem>
              </>
            ) : undefined
          }
        />
      ))}
    </RowList>
  );
}

function UsedByList({
  set,
  usage,
  actions,
}: {
  set: WorkspaceVariableSet;
  usage: VariableSetUsage;
  actions: VariableSetPageActions;
}) {
  if (!usage.known) {
    return (
      <RowList label={`What uses ${set.name}`} flush busy>
        <ListRowSkeleton count={2} />
      </RowList>
    );
  }
  if (usage.entries.length === 0) {
    return (
      <EmptyState
        variant="inline"
        title="Not used yet."
        description="Turn it on from the chat composer or a schedule."
        className="py-1"
      />
    );
  }
  return (
    <RowList label={`What uses ${set.name}`} flush>
      {usage.entries.map((entry) => {
        const Icon = USAGE_ICON[entry.kind];
        return (
          <ListRow
            key={entry.id}
            leading={<LogoTile icon={<Icon />} />}
            title={entry.name}
            description={entry.detail ? `${entry.kindLabel} · ${entry.detail}` : entry.kindLabel}
            indicator="open"
            href={entry.href}
            onOpen={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              actions.openUsage(entry);
            }}
          />
        );
      })}
    </RowList>
  );
}

export function VariableSetDetailPage({
  set,
  usage,
  organizationName,
  canManageSet,
  canManageSecrets,
  actions,
}: {
  set: WorkspaceVariableSet;
  usage: VariableSetUsage;
  organizationName: string;
  /** Rename and describe. */
  canManageSet: boolean;
  /** Add, replace and delete values; delete the set. */
  canManageSecrets: boolean;
  actions: VariableSetPageActions;
}) {
  const [tab, setTab] = useState<"variables" | "used-by">("variables");
  const empty = set.variables.length === 0;
  const summary = usageSummary(usage.entries);

  const scopeNote =
    set.scope === "organization" ? (
      <InlineHelp icon className="mb-4">
        {canManageSecrets
          ? `Shared with every workspace in ${organizationName}. Changes apply everywhere it's used.`
          : `Shared with every workspace in ${organizationName}. Only organization admins can change it.`}
      </InlineHelp>
    ) : set.scope === "user" ? (
      <InlineHelp icon className="mb-4">
        Only you can use this set. Only work you start gets these values.
      </InlineHelp>
    ) : null;

  const aside = (
    <DetailAside label={`About ${set.name}`}>
      {set.description ? (
        <DetailAsideItem label="Description">{set.description}</DetailAsideItem>
      ) : null}
      <DetailAsideItem label="Available to" icon={SCOPE_ICON[set.scope]}>
        {SCOPE_LABEL[set.scope]}
      </DetailAsideItem>
      <DetailAsideItem label="Last changed">
        <RelativeTime date={set.updatedAt} />
      </DetailAsideItem>
      <DetailAsideItem label="Created">
        <RelativeTime date={set.createdAt} format="date" />
      </DetailAsideItem>
      {canManageSecrets ? (
        <div className="border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={actions.deleteSet}
            className="-ml-2.5 text-danger hover:bg-danger/10 hover:text-danger pointer-coarse:h-11"
          >
            <Trash2Icon aria-hidden="true" />
            Delete variable set
          </Button>
        </div>
      ) : null}
    </DetailAside>
  );

  return (
    <DetailPage
      back={{ label: "Variable sets", onClick: actions.back }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <LineTabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
        <DetailPageHeader
          leading={<LogoTile icon={<VariableIcon />} />}
          title={set.name}
          chips={<ScopeChip scope={set.scope} />}
          meta={[
            <span key="count">{variablesLabel(set)}</span>,
            usage.known ? (
              <span key="usage">{summary ? `used by ${summary}` : "not used yet"}</span>
            ) : null,
            <span key="updated">
              updated <RelativeTime date={set.updatedAt} inSentence />
            </span>,
          ]}
          actions={
            <SetMenu
              set={set}
              canEdit={canManageSet}
              canDelete={canManageSecrets}
              actions={actions}
            />
          }
          tabs={
            <LineTabsList aria-label={`${set.name} sections`}>
              <LineTabsTrigger value="variables" count={set.variables.length}>
                Variables
              </LineTabsTrigger>
              <LineTabsTrigger
                value="used-by"
                count={usage.known ? usage.entries.length : undefined}
              >
                Used by
              </LineTabsTrigger>
            </LineTabsList>
          }
        />
        <DetailPageBody aside={aside}>
          <div className="min-w-0">
            <LineTabsContent value="variables">
              <DetailSection>
                <p className="mb-4 text-sm leading-5 text-fg-muted">
                  Agents get these as environment variables. Changes apply from the next turn.
                </p>
                {scopeNote}
                {empty && !canManageSecrets ? (
                  <EmptyState
                    variant="page"
                    icon={<VariableIcon />}
                    title="No variables yet"
                    description="Someone who can manage this set can add variables."
                    className="pt-8 pb-6"
                  />
                ) : (
                  <>
                    {empty ? (
                      <p className="px-3 pb-3 text-sm leading-5 text-fg-muted">
                        No variables yet. Add the keys and config agents need.
                      </p>
                    ) : (
                      <VariablesTable set={set} canManage={canManageSecrets} actions={actions} />
                    )}
                    {canManageSecrets ? (
                      <AddVariableRow
                        set={set}
                        onAdd={actions.addVariable}
                        onPaste={actions.pasteEnv}
                      />
                    ) : null}
                  </>
                )}
              </DetailSection>
            </LineTabsContent>
            <LineTabsContent value="used-by">
              <DetailSection>
                <p className="mb-4 text-sm leading-5 text-fg-muted">
                  Chats, schedules and environments that give agents this set.
                </p>
                <UsedByList set={set} usage={usage} actions={actions} />
              </DetailSection>
            </LineTabsContent>
          </div>
        </DetailPageBody>
      </LineTabs>
    </DetailPage>
  );
}

/** Loading, in the page's own shape. */
export function VariableSetDetailLoading({ onBack }: { onBack: () => void }) {
  return (
    <DetailPage
      back={{ label: "Variable sets", onClick: onBack }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <div role="status" aria-label="Loading variable set" className="min-w-0">
        <div aria-hidden="true" className="flex items-start gap-4">
          <Skeleton className="size-10 shrink-0 rounded-[10px] bg-surface-2" />
          <div className="min-w-0 flex-1 pt-1">
            <Skeleton className="h-5 w-48 rounded-full bg-surface-3" />
            <Skeleton className="mt-3 h-3.5 w-80 max-w-full rounded-full bg-surface-2" />
          </div>
        </div>
        <div aria-hidden="true" className="mt-6 flex gap-6 border-b border-border pb-3">
          <Skeleton className="h-3.5 w-20 rounded-full bg-surface-2" />
          <Skeleton className="h-3.5 w-16 rounded-full bg-surface-2" />
        </div>
        <div className="py-8">
          <RowList variant="table" label="Variables" busy columns={VARIABLE_COLUMNS}>
            <ListRowSkeleton count={4} />
          </RowList>
        </div>
      </div>
    </DetailPage>
  );
}

/** The set was deleted, or this person can't see it. */
export function VariableSetMissing({ onBack }: { onBack: () => void }) {
  return (
    <DetailPage
      back={{ label: "Variable sets", onClick: onBack }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <EmptyState
        variant="page"
        icon={<VariableIcon />}
        title="This variable set isn't here"
        description="It may have been deleted, or you don't have access to it."
        action={
          <Button type="button" variant="outline" onClick={onBack}>
            Back to variable sets
          </Button>
        }
      />
    </DetailPage>
  );
}
