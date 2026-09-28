import { useEffect, useState, type ReactNode } from "react";
import {
  BoxIcon,
  Building2Icon,
  CalendarClockIcon,
  ContainerIcon,
  EyeIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
  UserIcon,
  VariableIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DetailAside,
  DetailAsideItem,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { EmptyState } from "@/components/ui/empty-state";
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
import { RelativeTime } from "@/components/ui/relative-time";
import { SecretValue } from "@/components/ui/secret-field";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AddVariableRow,
  type NewVariableInput,
} from "@/components/variable-sets/variable-set-forms";
import type { WorkspaceVariableSet } from "@/types";

import { KIT_NOW, KIT_TIME_ZONE, organization } from "../../fixtures";
import { useAnswers, usePagePicks, useVerbs } from "./answers";
import {
  SCOPE_LABEL,
  exampleSecret,
  scopeChip,
  usageEntries,
  usageSummary,
  variablesLabel,
  type PreviewSet,
  type PreviewVariable,
  type UsageEntry,
} from "./model";

/* ----------------------------------------------------------------------------
   One variable set as its own page (the decided detail pick): back link,
   header with tile, scope chip and meta line, Variables | Used by tabs, and a
   quiet aside card with the set's facts.
   -------------------------------------------------------------------------- */

const TIME = { now: KIT_NOW, timeZone: KIT_TIME_ZONE } as const;

export interface SetActions {
  /** Saves one variable from the inline row. Throws a user-facing error. */
  addVariable: (variable: NewVariableInput) => Promise<void>;
  /** Opens the Paste .env page. */
  pasteEnv: () => void;
  replaceValue: (variable: PreviewVariable) => void;
  deleteVariable: (variable: PreviewVariable) => void;
  editSet: () => void;
  deleteSet: () => void;
  openUsage: (entry: UsageEntry) => void;
}

/* ----------------------------------------------------------------------------
   The ⋯ menu on the set.
   -------------------------------------------------------------------------- */

export function SetMenu({
  set,
  actions,
  size = "default",
}: {
  set: PreviewSet;
  actions: SetActions;
  size?: "default" | "sm";
}) {
  const answers = useAnswers();
  const verbs = useVerbs();
  const usage = usageSummary(set.usedBy);
  const blocked = usage !== null && answers.inUse === "disable";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={size === "sm" ? "icon-sm" : "icon"}
          aria-label={`More actions for ${set.name}`}
          className="text-fg-muted hover:text-fg pointer-coarse:size-11"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={actions.editSet}>
          <PencilIcon aria-hidden="true" />
          Edit details
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {blocked ? (
          <>
            <DropdownMenuItem disabled>
              <Trash2Icon aria-hidden="true" />
              {verbs.remove} variable set
            </DropdownMenuItem>
            <p className="px-2 pb-1.5 pl-8 text-xs leading-4.5 text-fg-muted">
              Used by {usage}. Remove it there first.
            </p>
          </>
        ) : (
          <DropdownMenuItem variant="destructive" onSelect={actions.deleteSet}>
            <Trash2Icon aria-hidden="true" />
            {verbs.remove} variable set
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ----------------------------------------------------------------------------
   Variables table.
   -------------------------------------------------------------------------- */

function useRevealCountdown(onDone: () => void, seconds = 30) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const timer = setInterval(() => {
      setLeft((current) => {
        if (current <= 1) {
          clearInterval(timer);
          onDone();
          return seconds;
        }
        return current - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- one countdown per reveal
  }, []);
  return left;
}

function RevealedValue({ variable, onHide }: { variable: PreviewVariable; onHide: () => void }) {
  const left = useRevealCountdown(onHide);
  return (
    <SecretValue
      kind="secret"
      name={variable.name}
      revealed={exampleSecret(variable.name)}
      revealNote={`Reveal logged · hides in ${left}s`}
      onHide={onHide}
    />
  );
}

function ValueCell({
  variable,
  revealed,
  onHide,
}: {
  variable: PreviewVariable;
  revealed: boolean;
  onHide: () => void;
}) {
  const answers = useAnswers();
  if (revealed) return <RevealedValue variable={variable} onHide={onHide} />;
  if (answers.plain === "shown" && variable.kind === "plain") {
    return <SecretValue kind="plain" value={variable.value} name={variable.name} />;
  }
  if (answers.versions === "kept") {
    // Today's constant placeholder, for comparison (Q18).
    return (
      <span
        aria-label="Hidden value"
        className="inline-flex h-5.5 items-center rounded-md border border-border bg-surface-2 px-2 font-mono text-xs tracking-[0.2em] text-fg-subtle"
      >
        ••••••
      </span>
    );
  }
  return <SecretValue kind="secret" name={variable.name} />;
}

export function VariablesTable({ set, actions }: { set: PreviewSet; actions: SetActions }) {
  const answers = useAnswers();
  const verbs = useVerbs();
  const [revealed, setRevealed] = useState<string | null>(null);
  // Folded on narrow lists, "Secret" and "v2" explain themselves; "Updated" doesn't.
  const columns: RowListColumn[] = [
    { id: "value", label: "Value", width: 232, hideLabel: true },
    ...(answers.versions === "kept"
      ? [{ id: "version", label: "Version", width: 72, hideLabel: true }]
      : []),
    { id: "updated", label: "Updated", width: 120 },
  ];

  return (
    <RowList variant="table" label={`Variables in ${set.name}`} columns={columns}>
      {set.variables.map((variable) => {
        const plainShown = answers.plain === "shown" && variable.kind === "plain";
        const canReveal = answers.reveal === "yes" && !plainShown && revealed !== variable.name;
        return (
          <ListRow
            key={variable.name}
            title={<span className="font-mono text-xs leading-5">{variable.name}</span>}
            cells={{
              value: (
                <ValueCell
                  variable={variable}
                  revealed={revealed === variable.name}
                  onHide={() => setRevealed(null)}
                />
              ),
              version: <span className="text-xs">v{variable.version}</span>,
              updated: <RelativeTime date={variable.updatedAt} className="text-xs" {...TIME} />,
            }}
            menuLabel={`Actions for ${variable.name}`}
            menu={
              <>
                {canReveal ? (
                  <DropdownMenuItem onSelect={() => setRevealed(variable.name)}>
                    <EyeIcon aria-hidden="true" />
                    Reveal value
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={() => actions.replaceValue(variable)}>
                  <PencilIcon aria-hidden="true" />
                  {plainShown ? "Edit value" : verbs.replace}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => actions.deleteVariable(variable)}
                >
                  <Trash2Icon aria-hidden="true" />
                  {verbs.remove}
                </DropdownMenuItem>
              </>
            }
          />
        );
      })}
    </RowList>
  );
}

/* ----------------------------------------------------------------------------
   Adding variables: the product's inline row at the bottom of the list (Name
   uppercased live, inline errors, clears and refocuses after Add) with a quiet
   Paste .env link. No header button and no one-variable page.
   -------------------------------------------------------------------------- */

/** The real row reads only the set's name and its variable names. */
function rowSet(set: PreviewSet): WorkspaceVariableSet {
  return {
    name: set.name,
    variables: set.variables.map((variable) => ({ name: variable.name })),
  } as unknown as WorkspaceVariableSet;
}

function AddVariables({ set, actions }: { set: PreviewSet; actions: SetActions }) {
  return (
    <AddVariableRow set={rowSet(set)} onAdd={actions.addVariable} onPaste={actions.pasteEnv} />
  );
}

/* ----------------------------------------------------------------------------
   Used by.
   -------------------------------------------------------------------------- */

const USAGE_ICON = {
  schedule: CalendarClockIcon,
  chat: MessageSquareIcon,
  environment_default: ContainerIcon,
} as const;

export function UsedByList({ set, actions }: { set: PreviewSet; actions: SetActions }) {
  const entries = usageEntries(set);
  if (entries.length === 0) {
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
    <RowList variant="resource" label={`What uses ${set.name}`}>
      {entries.map((entry) => {
        const Icon = USAGE_ICON[entry.kind];
        return (
          <ListRow
            key={entry.id}
            leading={<LogoTile icon={<Icon />} />}
            title={entry.name}
            description={`${entry.kindLabel} · ${entry.detail}`}
            indicator="open"
            href={entry.href}
            onOpen={(event) => {
              event.preventDefault();
              actions.openUsage(entry);
            }}
          />
        );
      })}
    </RowList>
  );
}

/* ----------------------------------------------------------------------------
   The whole detail.
   -------------------------------------------------------------------------- */

export function ScopeChip({ set }: { set: PreviewSet }) {
  const picks = usePagePicks();
  const label = scopeChip(set.scope);
  return label ? <MetaChip variant={picks.chip}>{label}</MetaChip> : null;
}

export function SetDetail({ set, actions }: { set: PreviewSet; actions: SetActions }) {
  const picks = usePagePicks();
  const verbs = useVerbs();
  const answers = useAnswers();
  const [tab, setTab] = useState<"variables" | "used-by">("variables");
  const blockedDelete = set.usedBy.length > 0 && answers.inUse === "disable";
  const empty = set.variables.length === 0;
  const usage = usageSummary(set.usedBy);
  // The Section pick's soft group (B) or tiles (C) put lists in one box.
  const box = (node: ReactNode) =>
    picks.section !== "open" ? (
      <div className="overflow-hidden rounded-[14px] border border-border bg-surface">{node}</div>
    ) : (
      node
    );

  const scopeNote =
    set.scope === "organization" ? (
      <InlineHelp icon className="mb-4">
        Shared with every workspace in {organization.name}. Changes apply everywhere it's used.
      </InlineHelp>
    ) : set.scope === "personal" ? (
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
        <RelativeTime date={set.updatedAt} {...TIME} />
      </DetailAsideItem>
      <div className="border-t border-border pt-4">
        <DisabledReason
          disabled={blockedDelete}
          reason={`Used by ${usage ?? ""}. Remove it there first.`}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={actions.deleteSet}
            className="-ml-2.5 text-danger hover:bg-danger/10 hover:text-danger pointer-coarse:h-11"
          >
            <Trash2Icon aria-hidden="true" />
            {verbs.remove} variable set
          </Button>
        </DisabledReason>
      </div>
    </DetailAside>
  );

  return (
    <LineTabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
      <DetailPageHeader
        leading={<LogoTile icon={<VariableIcon />} />}
        title={set.name}
        chips={<ScopeChip set={set} />}
        meta={[
          <span key="count">{variablesLabel(set)}</span>,
          <span key="usage">{usage ? `used by ${usage}` : "not used yet"}</span>,
          <span key="updated">
            updated <RelativeTime date={set.updatedAt} {...TIME} />
          </span>,
        ]}
        actions={<SetMenu set={set} actions={actions} />}
        tabs={
          <LineTabsList aria-label={`${set.name} sections`}>
            <LineTabsTrigger value="variables" count={set.variables.length}>
              Variables
            </LineTabsTrigger>
            <LineTabsTrigger value="used-by" count={set.usedBy.length}>
              Used by
            </LineTabsTrigger>
          </LineTabsList>
        }
      />
      <DetailPageBody aside={aside}>
        {/* One child, so the body's hairlines never draw under a hidden tab panel. */}
        <div className="min-w-0">
          <LineTabsContent value="variables">
            <DetailSection>
              <p className="mb-4 text-sm leading-5 text-fg-muted">
                Agents get these as environment variables. Changes apply from the next turn.
              </p>
              {scopeNote}
              {box(
                <>
                  {empty ? (
                    <p className="px-3 pb-3 text-sm leading-5 text-fg-muted">
                      No variables yet. Add the keys and config agents need.
                    </p>
                  ) : (
                    <VariablesTable set={set} actions={actions} />
                  )}
                  <AddVariables set={set} actions={actions} />
                </>,
              )}
            </DetailSection>
          </LineTabsContent>
          <LineTabsContent value="used-by">
            <DetailSection>
              <p className="mb-4 text-sm leading-5 text-fg-muted">
                Chats, schedules and environments that give agents this set.
              </p>
              {set.usedBy.length ? (
                box(<UsedByList set={set} actions={actions} />)
              ) : (
                <UsedByList set={set} actions={actions} />
              )}
            </DetailSection>
          </LineTabsContent>
        </div>
      </DetailPageBody>
    </LineTabs>
  );
}

const SCOPE_ICON = {
  workspace: <BoxIcon />,
  organization: <Building2Icon />,
  personal: <UserIcon />,
} as const;

/** Loading, in the page's own shape: header, tabs, then the variables table as row placeholders. */
export function SetDetailLoading() {
  return (
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
        <RowList
          variant="table"
          label="Variables"
          busy
          columns={[
            { id: "value", label: "Value", width: 232 },
            { id: "updated", label: "Updated", width: 120 },
          ]}
        >
          <ListRowSkeleton count={4} />
        </RowList>
      </div>
    </div>
  );
}

/** "Opens <name>": links to other pages can't leave the preview. */
export function announceUsage(entry: UsageEntry) {
  toast(`Opens ${entry.name}`, {
    description: `In the app this goes to the ${entry.kindLabel.toLocaleLowerCase()}. It has its own page preview.`,
  });
}
