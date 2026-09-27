/**
 * One schedule's own page: back to Schedules, the header with its actions,
 * then Overview (on/off, instructions, setup) and Runs. Never a side sheet.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClockIcon,
  CopyIcon,
  LinkIcon,
  LockIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  ServerIcon,
  SparklesIcon,
  TextCursorInputIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { useVariableSets } from "@opengeni/react";

import { Button } from "@/components/ui/button";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailFact, DetailFacts, DetailSection } from "@/components/ui/detail-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { InlineHelp } from "@/components/ui/inline-help";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@/components/ui/line-tabs";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SettingRow } from "@/components/ui/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { payerLabel } from "@/components/models/models-ui";
import { useAppContext } from "@/context";
import { formatElapsedSeconds } from "@/lib/format";
import { hasWorkspacePermission } from "@/lib/permissions";
import {
  knowledgeSyncSourceLabel,
  scheduledTaskDescription,
  scheduledTaskRunSessionAccess,
  scheduledTaskRunTriggerIsRedundant,
  scheduledTaskRunTriggerLabel,
  scheduledTaskStateLabel,
} from "@/lib/scheduled-tasks";
import { sessionDisplayTitle } from "@/lib/session-rename";
import { useWorkspaceMachines } from "@/lib/use-workspace-machines";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import { useWorkspaceRigs } from "@/lib/use-workspace-rigs";
import { cn } from "@/lib/utils";
import type { ScheduledTask, ScheduledTaskRun, Session } from "@/types";

import {
  NAME_MAX_LENGTH,
  isKnowledgeSync,
  nextRunOf,
  ownerName,
  runTimeLabel,
  scheduleErrorReference,
  scheduleErrorText,
  scheduleWords,
} from "./schedule-model";
import {
  OwnerValue,
  RunStatusBadge,
  ScheduleTile,
  schedulePath,
  schedulePermissions,
  useScheduleAccess,
  useScheduleNavigation,
  type ScheduleAccess,
} from "./schedule-parts";
import { useScheduleActions } from "./use-schedule-actions";

const POLL_MS = 30_000;

type Load =
  | { status: "loading" }
  | { status: "error"; error: Error; missing: boolean }
  | { status: "ready"; task: ScheduledTask };

type Runs =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; runs: ScheduledTaskRun[] };

function isMissing(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 404 || /\b404\b/.test(error instanceof Error ? error.message : "");
}

export function ScheduleDetailPage({
  workspaceId,
  scheduleId,
}: {
  workspaceId: string;
  scheduleId: string;
}) {
  const { client } = useAppContext();
  const access = useScheduleAccess(workspaceId);
  const go = useScheduleNavigation(workspaceId);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [runs, setRuns] = useState<Runs>({ status: "loading" });
  const [clock, setClock] = useState(() => new Date());
  const [tab, setTab] = useState("overview");
  const [renaming, setRenaming] = useState(false);
  const titleRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(
    async (background = false) => {
      try {
        const task = await client.getScheduledTask(workspaceId, scheduleId);
        setLoad({ status: "ready", task });
      } catch (error) {
        if (!background) {
          setLoad({
            status: "error",
            error: error instanceof Error ? error : new Error(String(error)),
            missing: isMissing(error),
          });
        }
        return;
      }
      try {
        const next = await client.listScheduledTaskRuns(workspaceId, scheduleId);
        setRuns({ status: "ready", runs: next });
      } catch {
        if (!background) setRuns({ status: "error" });
      }
      setClock(new Date());
    },
    [client, scheduleId, workspaceId],
  );

  useEffect(() => {
    setLoad({ status: "loading" });
    setRuns({ status: "loading" });
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const reconcile = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    const interval = window.setInterval(reconcile, POLL_MS);
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [refresh]);

  // The page opens in place, so focus moves to its title for screen readers.
  const ready = load.status === "ready";
  useEffect(() => {
    if (!ready) return;
    titleRef.current?.querySelector<HTMLElement>("h1, h2")?.focus?.();
  }, [ready]);

  const actions = useScheduleActions({
    workspaceId,
    onChanged: () => refresh(true),
    onDeleted: () => go.list(),
  });

  if (load.status === "loading") {
    return (
      <DetailPage back={{ label: "Schedules", onClick: go.list }}>
        <div className="flex items-start gap-4 border-b border-border pb-4" aria-busy="true">
          <Skeleton className="size-10 rounded-[10px]" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-80" />
          </div>
        </div>
        <span className="sr-only" role="status">
          Loading schedule
        </span>
      </DetailPage>
    );
  }

  if (load.status === "error") {
    return (
      <DetailPage back={{ label: "Schedules", onClick: go.list }}>
        {load.missing ? (
          <EmptyState
            variant="page"
            icon={<CalendarClockIcon />}
            title="This schedule doesn't exist"
            description="It may have been deleted. Your other schedules are on the list."
            action={
              <Button type="button" variant="outline" onClick={go.list}>
                Back to Schedules
              </Button>
            }
            className="pt-12"
          />
        ) : (
          <ErrorMessage
            align="center"
            title="Couldn't load this schedule"
            reference={scheduleErrorReference(load.error)}
            details={[{ label: "Error", value: scheduleErrorText(load.error) }]}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setLoad({ status: "loading" });
                  void refresh();
                }}
              >
                Try again
              </Button>
            }
          >
            Check your connection, then try again.
          </ErrorMessage>
        )}
      </DetailPage>
    );
  }

  const task = load.task;
  const perms = schedulePermissions(task, access);
  const busy = actions.busyTaskId === task.id;
  const runCount = runs.status === "ready" ? runs.runs.length : undefined;
  const latest = runs.status === "ready" ? runs.runs[0] : undefined;

  const copyLink = () => {
    const url = new URL(schedulePath(workspaceId, task.id), window.location.origin).toString();
    void navigator.clipboard
      ?.writeText(url)
      .then(() => toast("Link copied", { description: "People in this workspace can open it." }))
      .catch(() => toast.error("Couldn't copy the link"));
  };

  return (
    <DetailPage back={{ label: "Schedules", onClick: go.list }}>
      <LineTabs value={tab} onValueChange={setTab}>
        <div ref={titleRef}>
          <DetailPageHeader
            leading={<ScheduleTile task={task} />}
            title={task.name}
            chips={<StatusChip task={task} latest={latest} />}
            meta={[
              scheduleWords(task.schedule, clock).short,
              perms.own ? "by you" : `by ${ownerName(task)}`,
            ]}
            actions={
              <>
                {perms.canEdit ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => go.edit(task.id)}
                    className="pointer-coarse:h-11"
                  >
                    <PencilIcon aria-hidden="true" />
                    Edit
                  </Button>
                ) : null}
                {task.status === "paused" && perms.canPauseOrDelete ? (
                  <Button
                    type="button"
                    onClick={() => void actions.resume(task)}
                    disabled={busy}
                    className="pointer-coarse:h-11"
                  >
                    <PlayIcon aria-hidden="true" />
                    Resume
                  </Button>
                ) : perms.canRun ? (
                  <Button
                    type="button"
                    onClick={() => void actions.runNow(task)}
                    disabled={busy || !scheduledTaskStateLabel(task).active}
                    className="pointer-coarse:h-11"
                  >
                    <PlayIcon aria-hidden="true" />
                    Run now
                  </Button>
                ) : null}
                {!perms.canEdit && !perms.canRun && perms.canDuplicate ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => go.create({ from: task.id })}
                    className="pointer-coarse:h-11"
                  >
                    <CopyIcon aria-hidden="true" />
                    Duplicate
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`More actions for ${task.name}`}
                      className="text-fg-muted hover:text-fg pointer-coarse:size-11"
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    {perms.canEdit ? (
                      <DropdownMenuItem onSelect={() => setRenaming(true)}>
                        <TextCursorInputIcon />
                        Rename
                      </DropdownMenuItem>
                    ) : null}
                    {perms.canDuplicate && (perms.canEdit || perms.canRun) ? (
                      <DropdownMenuItem onSelect={() => go.create({ from: task.id })}>
                        <CopyIcon />
                        Duplicate
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem onSelect={copyLink}>
                      <LinkIcon />
                      Copy link
                    </DropdownMenuItem>
                    {perms.canPauseOrDelete ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={busy}
                          onSelect={() => actions.requestDelete(task)}
                        >
                          <Trash2Icon />
                          Delete
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            }
            tabs={
              <LineTabsList aria-label={`${task.name} sections`}>
                <LineTabsTrigger value="overview">Overview</LineTabsTrigger>
                <LineTabsTrigger value="runs" count={runCount}>
                  Runs
                </LineTabsTrigger>
              </LineTabsList>
            }
          />
        </div>
        <LineTabsContent value="overview">
          <DetailPageBody
            aside={
              <ScheduleAside task={task} access={access} now={clock} workspaceId={workspaceId} />
            }
          >
            <Overview
              task={task}
              access={access}
              latest={latest}
              busy={busy}
              now={clock}
              workspaceId={workspaceId}
              onActiveChange={(active) =>
                void (active ? actions.resume(task) : actions.pause(task))
              }
              onOpenSession={go.session}
            />
          </DetailPageBody>
        </LineTabsContent>
        <LineTabsContent value="runs">
          <DetailPageBody>
            <DetailSection className="pt-4">
              <RunsList
                task={task}
                runs={runs}
                access={access}
                now={clock}
                onRetry={() => {
                  setRuns({ status: "loading" });
                  void refresh();
                }}
                onOpenSession={go.session}
              />
            </DetailSection>
          </DetailPageBody>
        </LineTabsContent>
      </LineTabs>
      {actions.dialogs}
      <RenameDialog
        open={renaming}
        task={task}
        workspaceId={workspaceId}
        onOpenChange={setRenaming}
        onRenamed={() => void refresh(true)}
      />
    </DetailPage>
  );
}

/* ----------------------------------------------------------------------------
   Header chip.
   -------------------------------------------------------------------------- */

function StatusChip({ task, latest }: { task: ScheduledTask; latest?: ScheduledTaskRun }) {
  const state = scheduledTaskStateLabel(task);
  if (latest?.status === "dispatched") return <StatusBadge status="running" />;
  if (!state.active) {
    return <StatusBadge status="paused">{state.label}</StatusBadge>;
  }
  if (latest?.status === "failed") {
    return <StatusBadge status="failed">Last run failed</StatusBadge>;
  }
  return <StatusBadge status="active" />;
}

/* ----------------------------------------------------------------------------
   Overview.
   -------------------------------------------------------------------------- */

function Overview({
  task,
  access,
  latest,
  busy,
  now,
  workspaceId,
  onActiveChange,
  onOpenSession,
}: {
  task: ScheduledTask;
  access: ScheduleAccess;
  latest?: ScheduledTaskRun;
  busy: boolean;
  now: Date;
  workspaceId: string;
  onActiveChange: (active: boolean) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const perms = schedulePermissions(task, access);
  const knowledge = isKnowledgeSync(task);
  const state = scheduledTaskStateLabel(task);
  const next = nextRunOf(task, now);
  const sentence = `${scheduleWords(task.schedule, now).sentence}.`;
  const status =
    task.status === "paused"
      ? "Paused, so it won't run until you turn it back on."
      : !state.active
        ? `${state.label}, so it won't run.`
        : task.schedule.type === "manual"
          ? null
          : next
            ? `Next run ${runTimeLabel(next, now)}.`
            : "It has no runs left.";
  const owner = ownerName(task);
  const firstName = owner.split(" ")[0] ?? owner;
  const description = scheduledTaskDescription(task);
  return (
    <>
      <DetailSection className="pt-6">
        {latest?.status === "failed" ? (
          <Notice tone="failed" title="The last run failed" className="mb-4">
            {latest.error?.trim() || "Open the run's chat to see what went wrong."}
          </Notice>
        ) : null}
        <SettingRow
          label="Active"
          description={
            <>
              <span className="block">{sentence}</span>
              {status ? <span className="block">{status}</span> : null}
            </>
          }
          control={
            <Switch
              aria-label={`${task.name} is active`}
              checked={task.status === "active"}
              onCheckedChange={onActiveChange}
              pending={busy}
              disabled={!perms.canPauseOrDelete}
              disabledReason={
                perms.own
                  ? "You need permission to manage schedules in this workspace."
                  : `Only ${owner} can pause or resume it.`
              }
            />
          }
        />
        {!perms.own ? (
          <InlineHelp icon className="mt-3">
            It runs with {firstName}'s connected accounts, so only {firstName} can change, run,
            pause or delete it. Duplicate it to make your own.
          </InlineHelp>
        ) : null}
      </DetailSection>
      {knowledge ? (
        <DetailSection title="Source">
          <p className="m-0 text-sm leading-5 text-fg">
            {knowledgeSyncSourceLabel(
              task.action as Extract<ScheduledTask["action"], { kind: "knowledge_source_sync" }>,
            )}
          </p>
          <p className="mt-1 text-xs leading-4.5 text-fg-muted">
            Brings the source into Knowledge without starting a chat or using agent runs.
          </p>
        </DetailSection>
      ) : (
        <DetailSection title="Instructions">
          <Instructions text={task.agentConfig.prompt} />
        </DetailSection>
      )}
      {knowledge ? null : (
        <DetailSection title="Setup">
          <Setup
            task={task}
            access={access}
            workspaceId={workspaceId}
            description={description}
            onOpenSession={onOpenSession}
          />
        </DetailSection>
      )}
    </>
  );
}

function Instructions({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  // Offer "Show more" only when the clamp actually hides text.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);
  return (
    <div className="min-w-0">
      <p
        ref={ref}
        id={id}
        className={cn(
          "m-0 text-sm leading-5 break-words whitespace-pre-wrap text-fg",
          !expanded && "line-clamp-4",
        )}
      >
        {text}
      </p>
      {overflows || expanded ? (
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

const EACH_RUN: Record<ScheduledTask["runMode"], string> = {
  new_session_per_run: "New chat each run",
  reusable_session: "One ongoing chat",
  existing_session: "Posts into an existing chat",
};

const IF_STILL_RUNNING: Record<ScheduledTask["overlapPolicy"], string> = {
  allow_concurrent: "Queue the next run",
  buffer_one: "Queue the next run",
  skip: "Skip the next run",
};

function repositoryLabel(uri: string): string {
  const clean = uri.replace(/\.git$/, "").replace(/\/+$/, "");
  const match = /[:/]([^/:]+\/[^/]+)$/.exec(clean);
  return match?.[1] ?? clean;
}

function Setup({
  task,
  access,
  workspaceId,
  description,
  onOpenSession,
}: {
  task: ScheduledTask;
  access: ScheduleAccess;
  workspaceId: string;
  description: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const { accessContext, client, toolMcpServers } = useAppContext();
  const canListSets =
    hasWorkspacePermission(accessContext, workspaceId, "variable-sets:list") &&
    Boolean(task.variableSetId);
  const variableSets = useVariableSets({ enabled: canListSets });
  const rigs = useWorkspaceRigs({ enabled: Boolean(task.rigId) });
  const [chat, setChat] = useState<Session | null>(null);
  const targetId = task.runMode === "existing_session" ? task.targetSessionId : null;
  useEffect(() => {
    if (!targetId || !access.canTargetSessions) return;
    let live = true;
    void client
      .getSession(workspaceId, targetId)
      .then((session) => {
        if (live) setChat(session);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [access.canTargetSessions, client, targetId, workspaceId]);

  const setName = task.variableSetId
    ? variableSets.variableSets.find((set) => set.id === task.variableSetId)?.name
    : undefined;
  const rigName = task.rigId ? rigs.rigs.find((rig) => rig.id === task.rigId)?.name : undefined;
  const repositories = task.agentConfig.resources.filter(
    (resource): resource is Extract<typeof resource, { kind: "repository" }> =>
      resource.kind === "repository",
  );
  const tools = task.agentConfig.tools
    .filter((tool) => tool.kind === "mcp")
    .map((tool) =>
      tool.id === "opengeni"
        ? "Workspace tools"
        : (toolMcpServers.find((server) => server.id === tool.id)?.name ?? tool.id),
    );
  const variableSetsHref = `/workspaces/${encodeURIComponent(workspaceId)}/variable-sets`;
  return (
    <DetailFacts>
      <DetailFact label="Each run">{EACH_RUN[task.runMode]}</DetailFact>
      {task.runMode === "existing_session" && targetId ? (
        <DetailFact label="Chat">
          {chat || access.canReadSessionIds ? (
            <button
              type="button"
              onClick={() => onOpenSession(targetId)}
              className="rounded-[6px] text-left font-medium text-brand underline-offset-4 hover:underline"
            >
              {chat ? sessionDisplayTitle(chat) : "Open the chat"}
            </button>
          ) : (
            <span className="text-fg-muted">A chat you can't open</span>
          )}
        </DetailFact>
      ) : null}
      {task.runMode !== "new_session_per_run" ? (
        <DetailFact label="If still running">{IF_STILL_RUNNING[task.overlapPolicy]}</DetailFact>
      ) : null}
      {task.variableSetId ? (
        <DetailFact label="Variable set">
          <a
            href={variableSetsHref}
            className="rounded-[6px] font-medium text-brand underline-offset-4 hover:underline"
          >
            {setName ?? (variableSets.loading ? "Loading…" : "Attached variable set")}
          </a>
        </DetailFact>
      ) : null}
      {repositories.length > 0 ? (
        <DetailFact label={repositories.length === 1 ? "Repository" : "Repositories"}>
          <span className="flex min-w-0 flex-col">
            {repositories.map((repository) => (
              <span key={`${repository.uri}@${repository.ref}`} className="truncate">
                {repositoryLabel(repository.uri)}
                <span className="text-fg-muted"> · {repository.ref}</span>
              </span>
            ))}
          </span>
        </DetailFact>
      ) : null}
      {task.rigId ? (
        <DetailFact label="Environment">
          {rigName ?? (rigs.loading ? "Loading…" : "Attached Sandbox Environment")}
        </DetailFact>
      ) : null}
      {tools.length > 0 ? <DetailFact label="Tools">{tools.join(", ")}</DetailFact> : null}
      {description ? <DetailFact label="Description">{description}</DetailFact> : null}
    </DetailFacts>
  );
}

/* ----------------------------------------------------------------------------
   Aside.
   -------------------------------------------------------------------------- */

function ScheduleAside({
  task,
  access,
  now,
  workspaceId,
}: {
  task: ScheduledTask;
  access: ScheduleAccess;
  now: Date;
  workspaceId: string;
}) {
  const catalog = useWorkspaceModelCatalog(isKnowledgeSync(task) ? null : workspaceId);
  const machineId = task.agentConfig.machineTarget?.targetSandboxId;
  const fleet = useWorkspaceMachines({ enabled: Boolean(machineId) });
  const state = scheduledTaskStateLabel(task);
  const next = nextRunOf(task, now);
  const model = useMemo(() => {
    if (isKnowledgeSync(task)) return null;
    const chosen = task.agentConfig.model;
    const id = chosen ?? catalog.defaultSelection?.model;
    const row = id ? catalog.rows.find((candidate) => candidate.id === id) : undefined;
    const name = row ? `${row.label} · ${payerLabel(row.billingClass, row.providerLabel)}` : id;
    if (chosen) return name ?? chosen;
    return name ? `Workspace default - ${name}` : "Workspace default";
  }, [catalog.defaultSelection?.model, catalog.rows, task]);
  const machine = machineId
    ? fleet.machines.find((candidate) => candidate.sandboxId === machineId)
    : undefined;
  const where = machineId
    ? `${machine?.name ?? "Connected machine"}${
        task.agentConfig.machineTarget?.workingDir
          ? ` · ${task.agentConfig.machineTarget.workingDir}`
          : ""
      }`
    : task.runMode === "existing_session"
      ? "Where the chat runs"
      : "Managed sandbox";
  return (
    <DetailAside label={`About ${task.name}`}>
      <DetailAsideItem label="Owner">
        <OwnerValue task={task} viewerSubjectId={access.viewerSubjectId} size="md" />
      </DetailAsideItem>
      <DetailAsideItem label="Next run" icon={<CalendarClockIcon />}>
        {!state.active ? (
          <span className="text-fg-muted">{state.label}</span>
        ) : next ? (
          <RelativeTime date={next} format="absolute" />
        ) : (
          <span className="text-fg-muted">
            {task.schedule.type === "manual" ? "On demand" : "No runs left"}
          </span>
        )}
      </DetailAsideItem>
      {model ? (
        <DetailAsideItem label="Model" icon={<SparklesIcon />}>
          {catalog.loading ? "Loading…" : model}
        </DetailAsideItem>
      ) : null}
      {isKnowledgeSync(task) ? null : (
        <DetailAsideItem label="Where it runs" icon={<ServerIcon />}>
          {where}
        </DetailAsideItem>
      )}
      <DetailAsideItem label="Created">
        <RelativeTime date={task.createdAt} format="date" />
      </DetailAsideItem>
    </DetailAside>
  );
}

/* ----------------------------------------------------------------------------
   Runs.
   -------------------------------------------------------------------------- */

function isRecent(iso: string, now: Date): boolean {
  return now.getTime() - new Date(iso).getTime() < 12 * 60 * 60 * 1000;
}

function durationLabel(run: ScheduledTaskRun): string | null {
  if (!run.completedAt) return null;
  const seconds = Math.round(
    (new Date(run.completedAt).getTime() - new Date(run.firedAt).getTime()) / 1000,
  );
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return formatElapsedSeconds(seconds);
}

function runOutcome(run: ScheduledTaskRun): string | undefined {
  if (run.error?.trim()) return run.error.trim();
  const summary = run.knowledgeSummary;
  if (summary) {
    return `${summary.imported} imported · ${summary.unchanged} unchanged · ${summary.failed} failed`;
  }
  if (run.status === "skipped") return "Skipped because the previous run was still working.";
  if (run.status === "queued") return "Waiting to start.";
  return undefined;
}

function RunsList({
  task,
  runs,
  access,
  now,
  onRetry,
  onOpenSession,
}: {
  task: ScheduledTask;
  runs: Runs;
  access: ScheduleAccess;
  now: Date;
  onRetry: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  if (runs.status === "loading") {
    return (
      <RowList label={`Runs of ${task.name}`} busy flush>
        <ListRowSkeleton count={3} />
      </RowList>
    );
  }
  if (runs.status === "error") {
    return (
      <ErrorMessage
        title="Couldn't load this schedule's runs"
        action={
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }
  if (runs.runs.length === 0) {
    const next = nextRunOf(task, now);
    return (
      <EmptyState
        variant="inline"
        title="No runs yet."
        description={next ? `The first run is ${runTimeLabel(next, now)}.` : undefined}
        className="py-0"
      />
    );
  }
  const knowledge = isKnowledgeSync(task);
  return (
    <>
      <p className="m-0 mb-2 text-xs leading-4.5 text-fg-muted">
        {knowledge
          ? "Each run syncs the source into Knowledge."
          : "Each run opens its own chat. Open a run to see what it did."}
      </p>
      <RowList label={`Runs of ${task.name}`} flush>
        {runs.runs.map((run) => {
          const sessionAccess = scheduledTaskRunSessionAccess(run, {
            canReadSessionIds: access.canReadSessionIds,
          });
          const sessionId = run.sessionId;
          const meta = [
            durationLabel(run),
            scheduledTaskRunTriggerIsRedundant(run.triggerType)
              ? null
              : scheduledTaskRunTriggerLabel(run.triggerType),
            sessionAccess === "restricted" ? (
              <span key="lock" className="inline-flex items-center gap-1">
                <LockIcon aria-hidden="true" className="size-3" />
                You can't open this chat
              </span>
            ) : null,
          ].filter((part) => part !== null);
          return (
            <ListRow
              key={run.id}
              title={
                <RelativeTime
                  date={run.firedAt}
                  format={isRecent(run.firedAt, now) ? "relative" : "absolute"}
                />
              }
              titleAddon={<RunStatusBadge run={run} />}
              description={runOutcome(run)}
              meta={meta}
              {...(sessionAccess === "open" && sessionId
                ? { onOpen: () => onOpenSession(sessionId), indicator: "open" as const }
                : {})}
            />
          );
        })}
      </RowList>
    </>
  );
}

/* ----------------------------------------------------------------------------
   Rename: a one-field prompt, so a small centered dialog.
   -------------------------------------------------------------------------- */

function RenameDialog({
  open,
  task,
  workspaceId,
  onOpenChange,
  onRenamed,
}: {
  open: boolean;
  task: ScheduledTask;
  workspaceId: string;
  onOpenChange: (open: boolean) => void;
  onRenamed: () => void;
}) {
  const { client } = useAppContext();
  const [name, setName] = useState(task.name);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (open) {
      setName(task.name);
      setError(undefined);
    }
  }, [open, task.name]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Rename schedule"
      submitLabel="Rename"
      pendingLabel="Renaming…"
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setError("Enter a name.");
          return false;
        }
        if (trimmed.length > NAME_MAX_LENGTH) {
          setError(`Keep the name under ${NAME_MAX_LENGTH} characters.`);
          return false;
        }
        if (trimmed === task.name) return true;
        try {
          await client.updateScheduledTask(workspaceId, task.id, { name: trimmed });
        } catch (caught) {
          throw new Error(`Couldn't rename the schedule. ${scheduleErrorText(caught)}`, {
            cause: caught,
          });
        }
        toast.success("Renamed", { description: trimmed });
        onRenamed();
        return true;
      }}
      onSubmitted={() => onOpenChange(false)}
    >
      <FieldStack>
        <Field
          label="Name"
          error={error}
          hint="Shown in the list and as the title of each run's chat."
        >
          <TextInput
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError(undefined);
            }}
            suppressAutofill
          />
        </Field>
      </FieldStack>
    </FormDialog>
  );
}
