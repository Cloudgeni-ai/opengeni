import { useEffect, useState, type ReactNode } from "react";
import {
  CalendarClockIcon,
  ContainerIcon,
  EyeIcon,
  FileTextIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  VariableIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DetailBody,
  DetailFooter,
  DetailHeader,
  DetailSection,
  useDetailPresentation,
} from "@/components/ui/detail-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { EmptyState, EmptyStateLink } from "@/components/ui/empty-state";
import { InlineHelp } from "@/components/ui/inline-help";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { RelativeTime } from "@/components/ui/relative-time";
import { SecretValue } from "@/components/ui/secret-field";
import { Skeleton } from "@/components/ui/skeleton";

import { KIT_NOW, KIT_TIME_ZONE, organization } from "../../fixtures";
import { useAnswers, usePagePicks, useVerbs } from "./answers";
import {
  exampleSecret,
  scopeChip,
  usageEntries,
  usageSummary,
  type PreviewSet,
  type PreviewVariable,
  type UsageEntry,
} from "./model";

/* ----------------------------------------------------------------------------
   One variable set: header, variables table and "Used by". The same parts
   render as a page (the recommendation), a right sheet, or expanded in place
   (the other answers to Q19); the detail primitives adapt to where they are.
   -------------------------------------------------------------------------- */

const TIME = { now: KIT_NOW, timeZone: KIT_TIME_ZONE } as const;

export interface SetActions {
  addVariable: (mode: "one" | "paste") => void;
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
          Edit name and description
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
   Empty variables, following the Empty state pick.
   -------------------------------------------------------------------------- */

function NoVariables({ actions }: { actions: SetActions }) {
  const picks = usePagePicks();
  if (picks.empty === "inline") {
    return (
      <EmptyState
        variant="inline"
        title="No variables yet."
        action={
          <span className="flex items-center gap-4">
            <EmptyStateLink onClick={() => actions.addVariable("one")}>Add variable</EmptyStateLink>
            <EmptyStateLink onClick={() => actions.addVariable("paste")}>Paste .env</EmptyStateLink>
          </span>
        }
      />
    );
  }
  return (
    <EmptyState
      variant="page"
      icon={<VariableIcon />}
      title="No variables yet"
      description="Add the keys and config agents need, one at a time or from a .env file."
      className="pt-8 pb-6"
      action={
        <>
          <Button type="button" onClick={() => actions.addVariable("one")}>
            <PlusIcon aria-hidden="true" />
            Add variable
          </Button>
          <Button type="button" variant="outline" onClick={() => actions.addVariable("paste")}>
            <FileTextIcon aria-hidden="true" />
            Paste .env
          </Button>
        </>
      }
    />
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

export function SetDetail({
  set,
  actions,
  inlineForm,
  onDone,
}: {
  set: PreviewSet;
  actions: SetActions;
  /** An inline Add variable form (Form dialog pick C), shown above the table. */
  inlineForm?: ReactNode;
  /** Sheet only: closes it. */
  onDone?: () => void;
}) {
  const presentation = useDetailPresentation();
  const picks = usePagePicks();
  const verbs = useVerbs();
  const answers = useAnswers();
  const blockedDelete = set.usedBy.length > 0 && answers.inUse === "disable";
  const page = presentation === "page";
  const sheet = presentation === "sheet" || presentation === "preview";
  const inline = presentation === "inline";
  const empty = set.variables.length === 0;
  // The Section pick's soft group (B) or tiles (C) put lists in one box on pages.
  const box = (node: ReactNode) =>
    page && picks.section !== "open" ? (
      <div className="overflow-hidden rounded-[14px] border border-border bg-surface">{node}</div>
    ) : (
      node
    );

  const addButton = (
    <Button
      type="button"
      onClick={() => actions.addVariable("one")}
      className="pointer-coarse:h-11"
    >
      <PlusIcon aria-hidden="true" />
      Add variable
    </Button>
  );
  const smallAddButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => actions.addVariable("one")}
      className="pointer-coarse:h-11"
    >
      <PlusIcon aria-hidden="true" />
      Add variable
    </Button>
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

  const variables = (
    <DetailSection
      title={inline ? undefined : "Variables"}
      description={
        inline
          ? undefined
          : "Agents get these as environment variables. Changes apply from the next turn."
      }
      action={sheet && !empty ? smallAddButton : undefined}
    >
      {scopeNote}
      {inlineForm ? <div className="mb-6">{inlineForm}</div> : null}
      {empty ? (
        <NoVariables actions={actions} />
      ) : (
        box(<VariablesTable set={set} actions={actions} />)
      )}
    </DetailSection>
  );

  // Each row names its kind (Schedule, Chat, Sandbox environment), so no description.
  const usedBy = (
    <DetailSection title="Used by">
      {set.usedBy.length ? (
        box(<UsedByList set={set} actions={actions} />)
      ) : (
        <UsedByList set={set} actions={actions} />
      )}
    </DetailSection>
  );

  if (inline) {
    return (
      <>
        <DetailHeader
          title="Variables"
          subtitle={set.description}
          actions={
            <>
              {empty ? null : smallAddButton}
              <SetMenu set={set} actions={actions} size="sm" />
            </>
          }
        />
        <DetailBody>
          {variables}
          {usedBy}
        </DetailBody>
      </>
    );
  }

  return (
    <>
      <DetailHeader
        // Gap: the page header keeps its actions beside the title however
        // narrow the page gets; stack them under it on phone widths.
        className={
          page ? "@max-[560px]/detail:flex-col @max-[560px]/detail:items-stretch" : undefined
        }
        leading={
          page && picks.settingsIcon === "show" ? <LogoTile icon={<VariableIcon />} /> : undefined
        }
        title={set.name}
        status={<ScopeChip set={set} />}
        subtitle={set.description || undefined}
        actions={
          page ? (
            <>
              {empty ? null : addButton}
              <SetMenu set={set} actions={actions} />
            </>
          ) : (
            <SetMenu set={set} actions={actions} size="sm" />
          )
        }
      />
      <DetailBody>
        {variables}
        {usedBy}
      </DetailBody>
      {sheet ? (
        <DetailFooter
          start={
            <DisabledReason
              disabled={blockedDelete}
              reason={`Used by ${usageSummary(set.usedBy) ?? ""}. Remove it there first.`}
            >
              <Button
                type="button"
                variant="ghost"
                onClick={actions.deleteSet}
                className="-ml-3 text-danger hover:bg-danger/10 hover:text-danger pointer-coarse:h-11"
              >
                {verbs.remove} variable set
              </Button>
            </DisabledReason>
          }
        >
          <Button type="button" onClick={onDone} className="pointer-coarse:h-11">
            Done
          </Button>
        </DetailFooter>
      ) : null}
    </>
  );
}

/**
 * Loading, in the page's own shape: the header, then the variables table and
 * Used by as row placeholders (DetailSkeleton draws label/value facts instead).
 */
export function SetDetailLoading() {
  return (
    <div role="status" aria-label="Loading variable set" className="min-w-0">
      <div aria-hidden="true" className="border-b border-border pb-4">
        <Skeleton className="h-5 w-48 rounded-full bg-surface-3" />
        <Skeleton className="mt-3 h-3.5 w-80 max-w-full rounded-full bg-surface-2" />
      </div>
      <DetailBody>
        <DetailSection
          title="Variables"
          description="Agents get these as environment variables. Changes apply from the next turn."
        >
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
        </DetailSection>
        <DetailSection title="Used by">
          <RowList variant="resource" label="What uses this set" busy>
            <ListRowSkeleton count={1} />
          </RowList>
        </DetailSection>
      </DetailBody>
    </div>
  );
}

/** "Opens <name>": links to other pages can't leave the preview. */
export function announceUsage(entry: UsageEntry) {
  toast(`Opens ${entry.name}`, {
    description: `In the app this goes to the ${entry.kindLabel.toLocaleLowerCase()}. It has its own page preview.`,
  });
}
