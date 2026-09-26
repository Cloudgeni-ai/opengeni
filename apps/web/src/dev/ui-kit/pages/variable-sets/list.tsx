import { useMemo, useState, type ReactNode } from "react";
import {
  CloudIcon,
  DatabaseIcon,
  KeyRoundIcon,
  PlusIcon,
  RotateCcwIcon,
  VariableIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DetailInline } from "@/components/ui/detail-sheet";
import {
  EmptyState,
  EmptyStateLink,
  EmptyStateTemplate,
  EmptyStateTemplates,
} from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import {
  ListRow,
  ListRowSkeleton,
  RowList,
  type RowListColumn,
  type RowListSort,
} from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section } from "@/components/ui/section";
import { Toolbar, ToolbarSearch, ToolbarSummary } from "@/components/ui/toolbar";
import { cn } from "@/lib/utils";

import { KIT_NOW, KIT_TIME_ZONE, organization, type VariableSetScope } from "../../fixtures";
import { useAnswers, usePagePicks } from "./answers";
import { ScopeChip, SetDetail, type SetActions } from "./detail";
import { SET_TEMPLATES, type SetTemplate } from "./forms";
import { useFrame } from "./frame";
import { joinAnd, usageParts, usageSummary, variablesLabel, type PreviewSet } from "./model";

/* ----------------------------------------------------------------------------
   /variable-sets: one borderless list; the whole row opens the set. Sets are
   grouped by who can use them only when more than one kind exists, and the
   search appears only past 10 sets.
   -------------------------------------------------------------------------- */

const TIME = { now: KIT_NOW, timeZone: KIT_TIME_ZONE } as const;

export type LoadState = "ready" | "loading" | "error";

const SEARCH_THRESHOLD = 10;

const GROUPS: { scope: VariableSetScope; title: string; description?: string }[] = [
  { scope: "workspace", title: "This workspace" },
  {
    scope: "personal",
    title: "Only me",
    description: "Private to you. Only work you start gets these values.",
  },
  {
    scope: "organization",
    title: "Organization",
    description: `Shared with every workspace in ${organization.name}. Organization admins manage them.`,
  },
];

// Sized to their longest value, so the title and description keep the room.
const RESOURCE_COLUMNS: RowListColumn[] = [
  { id: "variables", label: "Variables", width: 72, hideLabel: true },
  { id: "usage", label: "Used by", width: 140, hideLabel: true },
  { id: "updated", label: "Updated", width: 80, hideLabel: true },
];

const COMPACT_COLUMNS = RESOURCE_COLUMNS.filter((column) => column.id !== "updated");

const TABLE_COLUMNS: RowListColumn[] = [
  { id: "variables", label: "Variables", width: 96, sortable: true },
  { id: "usage", label: "Used by", width: 208, sortable: true },
  { id: "updated", label: "Updated", width: 120, sortable: true },
];

const TEMPLATE_ICON: Record<string, ReactNode> = {
  aws: <CloudIcon />,
  github: <KeyRoundIcon />,
  database: <DatabaseIcon />,
};

/**
 * "Used by 1 schedule and 1 environment". In a resource row's column it takes
 * two lines, so the column stays narrow; folded into a meta line (phones,
 * catalog rows) it stays one.
 */
function UsageCell({ set, stacked }: { set: PreviewSet; stacked: boolean }) {
  const parts = usageParts(set.usedBy);
  const [first, ...rest] = parts;
  if (!first) return <>Not used</>;
  if (rest.length === 0) return <>Used by {first}</>;
  const tail = rest.length === 1 ? `and ${rest[0]}` : joinAnd(rest);
  if (!stacked) return <>Used by {joinAnd(parts)}</>;
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

function matches(set: PreviewSet, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return (
    set.name.toLocaleLowerCase().includes(needle) ||
    set.description.toLocaleLowerCase().includes(needle) ||
    set.variables.some((variable) => variable.name.toLocaleLowerCase().includes(needle))
  );
}

function sortSets(sets: PreviewSet[], sort: RowListSort): PreviewSet[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  const key = (set: PreviewSet): string | number => {
    if (sort.column === "variables") return set.variables.length;
    if (sort.column === "usage") return set.usedBy.length;
    if (sort.column === "updated") return -new Date(set.updatedAt).getTime();
    return set.name.toLocaleLowerCase();
  };
  return [...sets].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
    return String(a).localeCompare(String(b)) * factor;
  });
}

export interface ListPageProps {
  sets: PreviewSet[];
  loadState: LoadState;
  onRetry: () => void;
  /** The set whose sheet is open (Q19: sheet), for the selected row. */
  selectedId: string | null;
  /** The set expanded in place (Q19: in place). */
  expandedId: string | null;
  onOpenSet: (set: PreviewSet) => void;
  actionsFor: (set: PreviewSet) => SetActions;
  onNewSet: (template?: SetTemplate) => void;
  /** The inline New variable set form (Form dialog pick C). */
  inlineForm?: ReactNode;
}

/** Whether the page header should hide its primary action (the empty state shows it). */
export function listIsEmpty(sets: PreviewSet[], loadState: LoadState): boolean {
  return loadState === "ready" && sets.length === 0;
}

export function ListPage({
  sets,
  loadState,
  onRetry,
  selectedId,
  expandedId,
  onOpenSet,
  actionsFor,
  onNewSet,
  inlineForm,
}: ListPageProps) {
  const picks = usePagePicks();
  const answers = useAnswers();
  const { mode } = useFrame();
  const phone = mode === "phone";
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RowListSort>({ column: "name", direction: "asc" });
  const variant = picks.list;
  const table = variant === "table";
  // Where facts fold into one meta line, "Updated" is the one to drop.
  const compact = phone || variant === "catalog";
  const boxed = picks.section !== "open";

  const filtered = useMemo(() => {
    const found = sets.filter((set) => matches(set, query));
    return table ? sortSets(found, sort) : found;
  }, [query, sets, sort, table]);

  const scopes = new Set(sets.map((set) => set.scope));
  const grouped = scopes.size > 1;
  const showSearch = sets.length > SEARCH_THRESHOLD;

  const renderRow = (set: PreviewSet) => {
    const expandable = answers.opens === "inline";
    const usage = usageSummary(set.usedBy);
    return (
      <ListRow
        key={set.id}
        leading={<LogoTile icon={<VariableIcon />} />}
        title={set.name}
        titleAddon={grouped ? null : <ScopeChip set={set} />}
        description={set.description || undefined}
        cells={
          table
            ? {
                variables: set.variables.length,
                usage: usage ?? "Not used",
                updated: <RelativeTime date={set.updatedAt} {...TIME} />,
              }
            : {
                variables: variablesLabel(set),
                usage: <UsageCell set={set} stacked={variant === "resource"} />,
                updated: compact ? null : <RelativeTime date={set.updatedAt} {...TIME} />,
              }
        }
        indicator={expandable ? "expand" : "open"}
        selected={selectedId === set.id}
        onOpen={() => onOpenSet(set)}
        expanded={expandable ? expandedId === set.id : undefined}
        panel={
          expandable && expandedId === set.id ? (
            <DetailInline className="mt-1">
              <SetDetail set={set} actions={actionsFor(set)} />
            </DetailInline>
          ) : undefined
        }
      />
    );
  };

  const list = (rows: PreviewSet[], label: string) => (
    <RowList
      variant={variant}
      columns={table ? TABLE_COLUMNS : compact ? COMPACT_COLUMNS : RESOURCE_COLUMNS}
      label={label}
      nameSortable={table}
      sort={table ? sort : undefined}
      onSortChange={setSort}
    >
      {rows.map(renderRow)}
    </RowList>
  );

  const box = (node: ReactNode) =>
    boxed ? (
      <div className="overflow-hidden rounded-[14px] border border-border bg-surface">{node}</div>
    ) : (
      node
    );

  let body: ReactNode;
  if (loadState === "loading") {
    body = box(
      <RowList
        variant={variant}
        columns={table ? TABLE_COLUMNS : compact ? COMPACT_COLUMNS : RESOURCE_COLUMNS}
        label="Variable sets"
        busy
      >
        <ListRowSkeleton count={4} />
      </RowList>,
    );
  } else if (loadState === "error") {
    body = (
      <ErrorMessage
        variant="block"
        align="center"
        title="Couldn't load variable sets"
        reference="c41e7a09-5b2d-4f8e-9a31-7d0b6e2f4c18"
        details={[{ label: "Status", value: "503 Service Unavailable" }]}
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
  } else if (sets.length === 0) {
    if (picks.empty === "inline") {
      body = (
        <EmptyState
          variant="inline"
          title="No variable sets yet."
          description="Create one to give agents API keys and config without pasting them into chat."
          action={<EmptyStateLink onClick={() => onNewSet()}>New variable set</EmptyStateLink>}
        />
      );
    } else {
      body = (
        <EmptyState
          variant="page"
          icon={<VariableIcon />}
          title="No variable sets yet"
          description="Give agents API keys and config as environment variables, without pasting them into chat."
          action={
            <Button type="button" onClick={() => onNewSet()}>
              <PlusIcon aria-hidden="true" />
              New variable set
            </Button>
          }
          templates={
            picks.empty === "templates" ? (
              <EmptyStateTemplates label="Or start from a common set">
                {SET_TEMPLATES.map((template) => (
                  <EmptyStateTemplate
                    key={template.id}
                    icon={TEMPLATE_ICON[template.id]}
                    title={template.name}
                    description={template.description}
                    meta={template.env
                      .split("\n")
                      .map((line) => line.split("=")[0])
                      .join(", ")}
                    onSelect={() => onNewSet(template)}
                  />
                ))}
              </EmptyStateTemplates>
            ) : undefined
          }
        />
      );
    }
  } else {
    const noMatches =
      filtered.length === 0 ? (
        <EmptyState
          variant="inline"
          title={`No variable sets match "${query.trim()}".`}
          action={<EmptyStateLink onClick={() => setQuery("")}>Clear search</EmptyStateLink>}
        />
      ) : null;
    const groups = GROUPS.map((group) => ({
      ...group,
      sets: filtered.filter((set) => set.scope === group.scope),
    })).filter((group) => group.sets.length > 0);

    body = (
      <>
        {showSearch ? (
          <div className="mb-6 flex min-w-0 flex-col gap-2">
            <Toolbar>
              <ToolbarSearch
                value={query}
                onValueChange={setQuery}
                placeholder="Search variable sets and variable names"
                aria-label="Search variable sets"
              />
            </Toolbar>
            {query.trim() ? (
              <ToolbarSummary>
                {filtered.length} of {sets.length} variable sets
              </ToolbarSummary>
            ) : null}
          </div>
        ) : null}
        {noMatches ??
          (grouped ? (
            <div className="flex min-w-0 flex-col gap-10">
              {groups.map((group) => (
                <Section
                  key={group.scope}
                  variant="open"
                  title={
                    <>
                      {group.title}
                      <span className="ml-2 font-normal text-fg-subtle tabular-nums">
                        {group.sets.length}
                      </span>
                    </>
                  }
                  description={group.description}
                >
                  {box(list(group.sets, `Variable sets: ${group.title}`))}
                </Section>
              ))}
            </div>
          ) : (
            box(list(filtered, "Variable sets"))
          ))}
      </>
    );
  }

  return (
    <div className={cn("min-w-0")}>
      {inlineForm ? <div className="mb-8">{inlineForm}</div> : null}
      {body}
    </div>
  );
}
