/**
 * The schedule's detail: one body shown as a right sheet (A), a page (B) or
 * expanded under its row (C), following the detail-sheet pick.
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  CalendarClockIcon,
  CopyIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DetailBody,
  DetailFact,
  DetailFacts,
  DetailFooter,
  DetailHeader,
  DetailInline,
  DetailPage,
  DetailSection,
  DetailSheetPreview,
} from "@/components/ui/detail-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineHelp } from "@/components/ui/inline-help";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SettingRow } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { KIT_NOW, KIT_TIME_ZONE, type ScheduleRun } from "../../fixtures";
import {
  EACH_RUN_LABEL,
  IF_STILL_RUNNING_LABEL,
  NONE,
  WHERE_LABEL,
  cadenceSentence,
  environmentName,
  hasCustomLearning,
  learningSummary,
  modelLabel,
  nextRunOf,
  runTimeLabel,
  variableSetName,
  type ScheduleItem,
  type SchedulePermissions,
  type SchedulesQuestions,
} from "./model";
import { ToolMark } from "./tool-mark";
import type { SchedulePicks } from "./use-picks";

const TIME = { now: KIT_NOW, timeZone: KIT_TIME_ZONE };

export interface ScheduleDetailProps {
  item: ScheduleItem;
  perms: SchedulePermissions;
  questions: SchedulesQuestions;
  picks: SchedulePicks;
  /** Run now was pressed and the run is still going. */
  running?: boolean;
  /** The Active switch is saving. */
  savingActive?: boolean;
  onActiveChange: (active: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onCopyLink: () => void;
  onDelete: () => void;
  onOpenRun: (run: ScheduleRun) => void;
  onOpenVariableSet: (name: string) => void;
}

/* ----------------------------------------------------------------------------
   Actions. Only the ones the viewer can use are shown; the owner note in the
   body says why the rest are missing.
   -------------------------------------------------------------------------- */

function RunNowButton({ props, size }: { props: ScheduleDetailProps; size?: "sm" }) {
  return (
    <Button
      type="button"
      size={size}
      onClick={props.onRunNow}
      disabled={props.running}
      className="pointer-coarse:h-11"
    >
      <PlayIcon aria-hidden="true" />
      {props.running ? "Running…" : "Run now"}
    </Button>
  );
}

function EditButton({ props, size }: { props: ScheduleDetailProps; size?: "sm" }) {
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      onClick={props.onEdit}
      className="pointer-coarse:h-11"
    >
      <PencilIcon aria-hidden="true" />
      Edit
    </Button>
  );
}

/** Someone else's schedule: making your own copy is the one thing to do. */
function DuplicateButton({ props, size }: { props: ScheduleDetailProps; size?: "sm" }) {
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      onClick={props.onDuplicate}
      className="pointer-coarse:h-11"
    >
      <CopyIcon aria-hidden="true" />
      Duplicate
    </Button>
  );
}

function DeleteButton({ props, size }: { props: ScheduleDetailProps; size?: "sm" }) {
  if (!props.perms.canPauseOrDelete) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      onClick={props.onDelete}
      className="text-danger hover:bg-danger/10 hover:text-danger pointer-coarse:h-11"
    >
      <Trash2Icon aria-hidden="true" />
      Delete
    </Button>
  );
}

/** Edit and Run now for the owner, Duplicate for everyone else. */
function MainActions({ props, size }: { props: ScheduleDetailProps; size?: "sm" }) {
  if (!props.perms.canEditOrRun) return <DuplicateButton props={props} size={size} />;
  return (
    <>
      <EditButton props={props} size={size} />
      <RunNowButton props={props} size={size} />
    </>
  );
}

function MoreMenu({ props, withDelete }: { props: ScheduleDetailProps; withDelete?: boolean }) {
  // Duplicate is already a button when the viewer can't edit or run it.
  const duplicate = props.perms.canEditOrRun;
  const destructive = withDelete && props.perms.canPauseOrDelete;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`More actions for ${props.item.name}`}
          className="text-fg-muted hover:text-fg pointer-coarse:size-11"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {duplicate ? (
          <DropdownMenuItem onSelect={props.onDuplicate}>
            <CopyIcon />
            Duplicate
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={props.onCopyLink}>
          <LinkIcon />
          Copy link
        </DropdownMenuItem>
        {destructive ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={props.onDelete}>
              <Trash2Icon />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ----------------------------------------------------------------------------
   The body.
   -------------------------------------------------------------------------- */

function ActiveRow({ props }: { props: ScheduleDetailProps }) {
  const { item, perms, picks } = props;
  const active = item.state === "active";
  const next = nextRunOf(item);
  const sentence = `${cadenceSentence(item.cadence)}.`;
  const status = active
    ? next
      ? `Next run ${runTimeLabel(next)}.`
      : "It has no runs left."
    : "Paused, so it won't run until you turn it back on.";
  // Two lines, so a date never breaks across them.
  const description = (
    <>
      <span className="block">{sentence}</span>
      <span className="block">{status}</span>
    </>
  );
  return (
    <SettingRow
      variant={picks.settingRow}
      label="Active"
      description={description}
      control={
        <Switch
          checked={active}
          onCheckedChange={props.onActiveChange}
          pending={props.savingActive}
          variant={picks.switchVariant}
          showStateText={picks.switchStateText}
          disabled={!perms.canPauseOrDelete}
          disabledReason={perms.manageReason}
        />
      }
    />
  );
}

function Instructions({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  // Offer "Show more" only when the three-line clamp actually hides text.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);
  const long = overflows || expanded;
  return (
    <div className="min-w-0">
      <p
        ref={ref}
        id={id}
        className={cn(
          "m-0 text-sm leading-5 break-words whitespace-pre-wrap text-fg",
          !expanded && "line-clamp-3",
        )}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1.5 inline-flex rounded-[6px] text-xs leading-4.5 font-medium text-brand underline-offset-4 hover:underline pointer-coarse:min-h-11 pointer-coarse:items-center"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function Setup({ props }: { props: ScheduleDetailProps }) {
  const { item, questions } = props;
  const setName = item.variableSetId !== NONE ? variableSetName(item.variableSetId) : undefined;
  const environment = item.environmentId !== NONE ? environmentName(item.environmentId) : undefined;
  const showIfStillRunning = item.eachRun === "ongoing_chat" || !questions.q27OngoingOnly;
  return (
    <DetailFacts>
      <DetailFact label="Model">{modelLabel(item.modelId)}</DetailFact>
      <DetailFact label="Each run">{EACH_RUN_LABEL[item.eachRun]}</DetailFact>
      {showIfStillRunning ? (
        <DetailFact label="If still running">
          {IF_STILL_RUNNING_LABEL[item.ifStillRunning]}
        </DetailFact>
      ) : null}
      <DetailFact label="Where it runs">{WHERE_LABEL[item.whereItRuns]}</DetailFact>
      {setName ? (
        <DetailFact label="Variable set">
          <button
            type="button"
            onClick={() => props.onOpenVariableSet(setName)}
            className="rounded-[6px] text-left font-medium text-brand underline-offset-4 hover:underline"
          >
            {setName}
          </button>
        </DetailFact>
      ) : null}
      {item.repository !== NONE ? (
        <DetailFact label="Repository">{item.repository}</DetailFact>
      ) : null}
      {environment ? <DetailFact label="Environment">{environment}</DetailFact> : null}
      {item.tools.length > 0 ? (
        <DetailFact label="Tools">
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {item.tools.map((tool) => (
              <ToolMark key={tool} toolId={tool} />
            ))}
          </span>
        </DetailFact>
      ) : null}
      {hasCustomLearning(item.learning) ? (
        <DetailFact label="Agent learning">{learningSummary(item.learning)}</DetailFact>
      ) : null}
      {!questions.q22RemoveDescription && item.description ? (
        <DetailFact label="Description">{item.description}</DetailFact>
      ) : null}
    </DetailFacts>
  );
}

function isRecent(iso: string): boolean {
  return KIT_NOW.getTime() - new Date(iso).getTime() < 12 * 60 * 60 * 1000;
}

function Runs({ props }: { props: ScheduleDetailProps }) {
  const { item, running } = props;
  if (item.runs.length === 0 && !running) {
    const next = nextRunOf(item);
    return (
      <EmptyState
        variant="inline"
        title="No runs yet."
        description={next ? `The first run is ${runTimeLabel(next)}.` : undefined}
        className="py-0"
      />
    );
  }
  return (
    <RowList label={`Runs of ${item.name}`} variant="resource" className="-mx-3">
      {running ? (
        <ListRow
          title="Just now"
          titleAddon={<StatusBadge variant="dot" status="running" />}
          description="Started with Run now. The chat opens as soon as it has something to show."
          indicator={{ kind: "loading", label: "Running" }}
        />
      ) : null}
      {item.runs.map((run) => (
        <ListRow
          key={run.id}
          title={
            <RelativeTime
              date={run.startedAt}
              format={isRecent(run.startedAt) ? "relative" : "absolute"}
              {...TIME}
            />
          }
          titleAddon={
            <StatusBadge variant="dot" status={run.status === "failed" ? "failed" : "succeeded"} />
          }
          description={run.outcome}
          meta={[run.durationLabel, run.triggerLabel]}
          onOpen={() => props.onOpenRun(run)}
          indicator="open"
        />
      ))}
    </RowList>
  );
}

function FailedNotice({ props }: { props: ScheduleDetailProps }) {
  const { item } = props;
  const [latest] = item.runs;
  if (item.lastRun.status !== "failed" || !latest || latest.status !== "failed") return null;
  const setName = item.variableSetId !== NONE ? variableSetName(item.variableSetId) : undefined;
  return (
    <Notice
      tone="failed"
      title="The last run failed"
      actionLayout="responsive"
      action={
        setName ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => props.onOpenVariableSet(setName)}
            className="pointer-coarse:h-11"
          >
            Open {setName}
          </Button>
        ) : undefined
      }
      className="mb-4"
    >
      {latest.outcome}
      {setName ? " Replace the keys, then run it again." : " Run it again to retry."}
    </Notice>
  );
}

export function ScheduleDetailBody({ props }: { props: ScheduleDetailProps }) {
  const { perms, item } = props;
  return (
    <DetailBody>
      <DetailSection className="pt-4">
        <FailedNotice props={props} />
        <ActiveRow props={props} />
        {!perms.own ? (
          <InlineHelp icon className="mt-3">
            It runs with {perms.ownerFirstName}'s connected accounts, so only{" "}
            {perms.ownerFirstName} can{" "}
            {perms.canPauseOrDelete ? "edit or run it." : "change, run, pause or delete it."}
          </InlineHelp>
        ) : null}
      </DetailSection>
      <DetailSection title="Instructions">
        <Instructions text={item.instructions} />
      </DetailSection>
      <DetailSection title="Setup">
        <Setup props={props} />
      </DetailSection>
      <DetailSection title="Runs">
        <Runs props={props} />
      </DetailSection>
    </DetailBody>
  );
}

function ownerSubtitle(props: ScheduleDetailProps): ReactNode {
  return props.perms.own ? undefined : `Owned by ${props.perms.ownerName}`;
}

/* ----------------------------------------------------------------------------
   A. Right sheet.
   -------------------------------------------------------------------------- */

export function ScheduleSheet({
  props,
  onClose,
  className,
}: {
  props: ScheduleDetailProps;
  onClose?: () => void;
  className?: string;
}) {
  return (
    <DetailSheetPreview
      label={props.item.name}
      onClose={onClose}
      className={cn("h-full max-w-none border-l-0", className)}
    >
      <DetailHeader
        leading={<LogoTile icon={<CalendarClockIcon />} />}
        title={props.item.name}
        subtitle={ownerSubtitle(props)}
        actions={<MoreMenu props={props} />}
        showClose={Boolean(onClose)}
      />
      <ScheduleDetailBody props={props} />
      <DetailFooter start={<DeleteButton props={props} />}>
        <MainActions props={props} />
      </DetailFooter>
    </DetailSheetPreview>
  );
}

/* ----------------------------------------------------------------------------
   B. Detail page.
   -------------------------------------------------------------------------- */

export function SchedulePage({
  props,
  onBack,
}: {
  props: ScheduleDetailProps;
  onBack: () => void;
}) {
  return (
    <DetailPage back={{ label: "Schedules", onClick: onBack }} className="px-0 pt-0 max-sm:px-0">
      <DetailHeader
        leading={<LogoTile icon={<CalendarClockIcon />} />}
        title={props.item.name}
        subtitle={ownerSubtitle(props)}
        actions={
          <>
            <MainActions props={props} />
            <MoreMenu props={props} withDelete />
          </>
        }
      />
      <ScheduleDetailBody props={props} />
    </DetailPage>
  );
}

/* ----------------------------------------------------------------------------
   C. Expanded under the row.
   -------------------------------------------------------------------------- */

export function ScheduleInline({ props }: { props: ScheduleDetailProps }) {
  return (
    <DetailInline>
      <ScheduleDetailBody props={props} />
      <DetailFooter start={<DeleteButton props={props} size="sm" />}>
        <MoreMenu props={props} />
        <MainActions props={props} size="sm" />
      </DetailFooter>
    </DetailInline>
  );
}
