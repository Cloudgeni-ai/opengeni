/**
 * A drop-in Automations panel: the automations of a workspace or of one chat,
 * with create and edit, on and off, Run now, delete and recent runs. The host
 * hands it its OpenGeniClient; the panel reads and writes through it and keeps
 * its own navigation (the list, one automation, the form), so it fits a
 * dialog, a sheet or a page.
 *
 * Runs inherit their access: an automation in a chat runs with that chat's
 * settings, and one that starts a new chat each run follows the workspace's
 * defaults with its owner's access, like a new chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarClockIcon, ChevronLeftIcon, PlayIcon, PlusIcon, ZapIcon } from "lucide-react";

import type {
  EventSource,
  EventTypeDescriptor,
  OpenGeniClient,
  ScheduledTask,
  ScheduledTaskRun,
} from "@opengeni/sdk";

import { useOpenGeniText } from "../../messages/runtime";
import { apiErrorFacts } from "../../ui/api-error";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { DropdownMenuItem } from "../../ui/dropdown-menu";
import { EmptyState } from "../../ui/empty-state";
import { ErrorMessage } from "../../ui/error-message";
import { ListRow, ListRowSkeleton, RowList } from "../../ui/list-row";
import { LogoTile } from "../../ui/logo-tile";
import { RelativeTime, useMinuteNow } from "../../ui/relative-time";
import { Skeleton } from "../../ui/skeleton";
import { StatusBadge, type ProductStatus } from "../../ui/status-badge";
import { Switch } from "../../ui/switch";
import { TooltipProvider } from "../../ui/tooltip";
import { formatRunTime } from "../../ui/cadence-picker";
import { cn } from "../../lib/cn";
import { AutomationForm, errorSentence } from "./automation-form";
import {
  automationCreateRequest,
  automationDraftFrom,
  automationNextRun,
  automationRunEventsLabel,
  automationRunStatusLabel,
  automationRunTriggerLabel,
  automationUpdateRequest,
  automationWhenSentence,
  automationWhenWords,
  hasEventTriggers,
  isAgentAutomation,
  isFinishedOnce,
  newAutomationDraft,
  sortAutomations,
  viewerTimeZone,
  type AutomationDraft,
} from "./automation-model";
import type { EventSourceLogoResolver } from "./event-source-tile";
import { EventTriggerSummary } from "./event-trigger-summary";

/** An MCP server whose events people can pick without adding a source first. */
export interface AutomationEventServer {
  /** The MCP server id as configured for the workspace. */
  serverId: string;
  /** Its name in the source picker. Default: the server id. */
  name?: string | undefined;
}

export interface AutomationsPanelProps {
  client: OpenGeniClient;
  workspaceId: string;
  /**
   * Scope it to one chat: that chat's automations, and new ones continue it.
   * Without it: the workspace's automations, and new ones start a new chat
   * each run.
   */
  sessionId?: string | undefined;
  /** Null omits the heading when the host already supplies one. */
  title?: string | null | undefined;
  /** Offer event triggers. Default: whenever this server runs them. */
  eventTriggers?: boolean | undefined;
  /**
   * MCP servers whose events people can pick right away, such as the host's
   * own. The person's event source for a server is added the first time they
   * pick it.
   */
  eventServers?: readonly AutomationEventServer[] | undefined;
  /** Arguments new MCP subscriptions start with, such as `{ projectId }`. */
  argumentDefaults?: Readonly<Record<string, unknown>> | undefined;
  /** Brand logos for event sources, from the host's connector catalog. */
  sourceLogo?: EventSourceLogoResolver | undefined;
  /** Opens the chat a run happened in. Without it, runs don't link anywhere. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
  className?: string | undefined;
}

type View =
  | { kind: "list" }
  | { kind: "detail"; taskId: string }
  | { kind: "form"; taskId: string | null };

type Notice = { tone: "info" | "error"; text: string } | null;

const SERVER_SOURCE_PREFIX = "mcp-server:";

/** A server's place in the source picker until the person's source for it exists. */
function serverSource(server: AutomationEventServer, workspaceId: string): EventSource {
  return {
    id: `${SERVER_SOURCE_PREFIX}${server.serverId}`,
    workspaceId,
    kind: "mcp",
    adapter: null,
    name: server.name ?? server.serverId,
    ownerSubjectId: null,
    visibility: "private",
    status: "active",
    statusReason: null,
    webhookUrl: null,
    awaitingSigningSecret: false,
    mcp: { serverId: server.serverId, connectionId: null },
    lastDeliveryAt: null,
    createdAt: "",
    updatedAt: "",
  };
}

function newTriggerId(): string | undefined {
  return globalThis.crypto?.randomUUID?.();
}

export function AutomationsPanel({
  client,
  workspaceId,
  sessionId,
  title: titleProp,
  eventTriggers: eventTriggersProp,
  eventServers,
  argumentDefaults,
  sourceLogo,
  onOpenSession,
  className,
}: AutomationsPanelProps) {
  const t = useOpenGeniText();
  const title = titleProp === undefined ? t("automations.panel.title") : titleProp;
  const now = new Date(useMinuteNow());
  const [view, setView] = useState<View>({ kind: "list" });
  const [notice, setNotice] = useState<Notice>(null);
  /** Another view; what the last action said belongs to the one it was done in. */
  const go = useCallback((next: View) => {
    setNotice(null);
    setView(next);
  }, []);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null);
  /** The last Run now, so the automation's recent runs can look for the run it started. */
  const [started, setStarted] = useState<{ taskId: string; at: number } | null>(null);

  /* Automations. */
  const [tasks, setTasks] = useState<ScheduledTask[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoadError(null);
    client.listScheduledTasks(workspaceId, sessionId ? { sessionId } : {}).then(
      (list) => {
        if (live) setTasks(list.filter(isAgentAutomation));
      },
      (error: unknown) => {
        if (live) setLoadError(error);
      },
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId, sessionId, loadAttempt]);
  const upsert = useCallback((task: ScheduledTask) => {
    setTasks((current) =>
      current?.some((entry) => entry.id === task.id)
        ? current.map((entry) => (entry.id === task.id ? task : entry))
        : [...(current ?? []), task],
    );
  }, []);

  /* Event sources: whether events run here, and what triggers can point at. */
  const [sources, setSources] = useState<EventSource[] | undefined>(undefined);
  const [eventsRun, setEventsRun] = useState<boolean | undefined>(undefined);
  const [sourcesAttempt, setSourcesAttempt] = useState(0);
  useEffect(() => {
    if (eventTriggersProp === false) return;
    let live = true;
    client.listEventSources(workspaceId).then(
      (list) => {
        if (!live) return;
        setSources(list);
        setEventsRun(true);
      },
      (error: unknown) => {
        if (!live) return;
        // This server doesn't run event triggers; anything else still offers them.
        setEventsRun(apiErrorFacts(error).status !== 404);
        setSources((current) => current ?? []);
      },
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId, eventTriggersProp, sourcesAttempt]);
  const eventTriggers = eventTriggersProp !== false && eventsRun === true;

  // The host's MCP servers without a source yet stand in for one until picked.
  const ensured = useRef(new Map<string, Promise<EventSource>>());
  const formSources = useMemo(() => {
    if (!sources) return undefined;
    const missing = (eventServers ?? []).filter(
      (server) =>
        !sources.some(
          (source) => source.kind === "mcp" && source.mcp?.serverId === server.serverId,
        ),
    );
    return [...sources, ...missing.map((server) => serverSource(server, workspaceId))];
  }, [eventServers, sources, workspaceId]);
  const realSource = useCallback(
    (sourceId: string): Promise<string> => {
      if (!sourceId.startsWith(SERVER_SOURCE_PREFIX)) return Promise.resolve(sourceId);
      const serverId = sourceId.slice(SERVER_SOURCE_PREFIX.length);
      let pending = ensured.current.get(serverId);
      if (!pending) {
        const name = eventServers?.find((server) => server.serverId === serverId)?.name;
        pending = client
          .createEventSource(workspaceId, { kind: "mcp", serverId, ...(name ? { name } : {}) })
          .then((created) => created.source);
        ensured.current.set(serverId, pending);
        pending.catch(() => ensured.current.delete(serverId));
      }
      return pending.then((source) => source.id);
    },
    [client, eventServers, workspaceId],
  );
  const loadEventTypes = useCallback(
    async (sourceId: string): Promise<EventTypeDescriptor[]> =>
      client.listEventSourceTypes(workspaceId, await realSource(sourceId)),
    [client, realSource, workspaceId],
  );
  /** The draft with every stand-in source replaced by the person's own. */
  const withRealSources = async (draft: AutomationDraft): Promise<AutomationDraft> => {
    const triggers = await Promise.all(
      draft.events.triggers.map(async (trigger) => ({
        ...trigger,
        sourceId: await realSource(trigger.sourceId),
      })),
    );
    return { ...draft, events: { ...draft.events, triggers } };
  };

  /* Actions. */
  const act = async (task: ScheduledTask, run: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(task.id));
    setNotice(null);
    try {
      await run();
    } catch (error) {
      setNotice({
        tone: "error",
        text: t("automations.panel.actionFailed", { reason: errorSentence(error) }).trim(),
      });
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  };
  const setOn = (task: ScheduledTask, on: boolean) =>
    act(task, async () =>
      upsert(
        on
          ? await client.resumeScheduledTask(workspaceId, task.id)
          : await client.pauseScheduledTask(workspaceId, task.id),
      ),
    );
  const runNow = (task: ScheduledTask) =>
    act(task, async () => {
      const triggerId = newTriggerId();
      upsert(
        await client.triggerScheduledTask(workspaceId, task.id, triggerId ? { triggerId } : {}),
      );
      setStarted({ taskId: task.id, at: Date.now() });
      setNotice({ tone: "info", text: t("automations.panel.runStarted", { name: task.name }) });
    });
  const remove = async (task: ScheduledTask): Promise<boolean> => {
    try {
      await client.deleteScheduledTask(workspaceId, task.id);
      setTasks((current) => current?.filter((entry) => entry.id !== task.id));
      go({ kind: "list" });
      return true;
    } catch (error) {
      setNotice({
        tone: "error",
        text: t("automations.panel.actionFailed", { reason: errorSentence(error) }).trim(),
      });
      return false;
    }
  };
  const save = async (task: ScheduledTask | null, draft: AutomationDraft) => {
    const ready = await withRealSources(draft);
    const saved = task
      ? await client.updateScheduledTask(workspaceId, task.id, {
          expectedExecutionDigest: task.executionDigest,
          ...automationUpdateRequest(t, automationDraftFrom(task), ready, new Date()),
        })
      : await client.createScheduledTask(
          workspaceId,
          automationCreateRequest(
            t,
            ready,
            sessionId ? { kind: "chat", sessionId } : { kind: "new_chat" },
            new Date(),
          ),
        );
    upsert(saved);
    if (draft.events.triggers.some((trigger) => trigger.sourceId.startsWith(SERVER_SOURCE_PREFIX)))
      setSourcesAttempt((value) => value + 1);
    go({ kind: "detail", taskId: saved.id });
  };

  const menu = (task: ScheduledTask) => (
    <>
      <DropdownMenuItem onSelect={() => void runNow(task)}>
        {t("automations.panel.runNow")}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => go({ kind: "form", taskId: task.id })}>
        {t("automations.panel.edit")}
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(task)}>
        {t("automations.panel.delete")}
      </DropdownMenuItem>
    </>
  );
  const viewed =
    view.kind === "list" ? null : (tasks?.find((task) => task.id === view.taskId) ?? null);
  // A live region that stays mounted in the list and on an automation's page,
  // so what an action says is announced where it was done.
  const noticeLine = (
    <p
      role="status"
      className={cn(
        "m-0 text-sm leading-5 empty:hidden",
        notice?.tone === "error" ? "text-danger" : "text-fg-muted",
      )}
    >
      {notice?.text}
    </p>
  );

  let body: ReactNode;
  if (view.kind === "form") {
    const task = view.taskId ? viewed : null;
    body = (
      <div className="flex min-w-0 flex-col gap-4">
        <BackButton
          onClick={() => go(task ? { kind: "detail", taskId: task.id } : { kind: "list" })}
        />
        <h3 className="m-0 text-base leading-6 font-semibold text-fg">
          {task ? t("automations.form.editTitle") : t("automations.form.newTitle")}
        </h3>
        <AutomationForm
          key={task?.id ?? "new"}
          initial={
            task
              ? automationDraftFrom(task)
              : newAutomationDraft(eventTriggers ? { cadence: null } : {})
          }
          editing={Boolean(task)}
          destination={
            task
              ? task.runMode === "new_session_per_run"
                ? "new_chat"
                : "chat"
              : sessionId
                ? "chat"
                : "new_chat"
          }
          eventTriggers={eventTriggers || hasEventTriggers(task ?? {})}
          sources={formSources}
          loadEventTypes={loadEventTypes}
          sourceLogo={sourceLogo}
          argumentDefaults={argumentDefaults}
          onSubmit={(draft) => save(task, draft)}
          onCancel={() => go(task ? { kind: "detail", taskId: task.id } : { kind: "list" })}
          now={now}
        />
      </div>
    );
  } else if (view.kind === "detail" && viewed) {
    body = (
      <AutomationDetail
        client={client}
        workspaceId={workspaceId}
        task={viewed}
        sessionId={sessionId}
        sources={sources}
        sourceLogo={sourceLogo}
        onOpenSession={onOpenSession}
        busy={busy.has(viewed.id)}
        startedAt={started?.taskId === viewed.id ? started.at : null}
        now={now}
        onBack={() => go({ kind: "list" })}
        onSetOn={(on) => void setOn(viewed, on)}
        onRunNow={() => void runNow(viewed)}
        onEdit={() => go({ kind: "form", taskId: viewed.id })}
        onDelete={() => setDeleting(viewed)}
        notice={noticeLine}
      />
    );
  } else if (loadError && !tasks) {
    body = (
      <ErrorMessage
        variant="block"
        align="center"
        title={t("automations.panel.loadFailed")}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLoadAttempt((value) => value + 1)}
          >
            {t("automations.panel.tryAgain")}
          </Button>
        }
      >
        {t("automations.panel.loadFailedBody")}
      </ErrorMessage>
    );
  } else if (!tasks) {
    body = (
      <RowList label={t("automations.panel.list")} busy flush>
        <ListRowSkeleton count={3} />
      </RowList>
    );
  } else if (tasks.length === 0) {
    body = (
      <EmptyState
        icon={eventTriggers ? <ZapIcon /> : <CalendarClockIcon />}
        title={sessionId ? t("automations.panel.emptyChat") : t("automations.panel.empty")}
        description={
          sessionId ? t("automations.panel.descriptionChat") : t("automations.panel.description")
        }
        action={
          <Button type="button" size="sm" onClick={() => go({ kind: "form", taskId: null })}>
            <PlusIcon aria-hidden="true" />
            {t("automations.panel.new")}
          </Button>
        }
      />
    );
  } else {
    body = (
      <RowList label={t("automations.panel.list")} flush>
        {sortAutomations(tasks, now).map((task) => {
          const next = automationNextRun(task, now);
          return (
            <ListRow
              key={task.id}
              leading={<AutomationTile task={task} />}
              title={task.name}
              description={automationWhenWords(t, task, sources ?? [], now)}
              status={showsStatus(task) ? <AutomationStatus task={task} /> : undefined}
              meta={
                next
                  ? [
                      t("automations.panel.next", {
                        time: formatRunTime(next, { timeZone: viewerTimeZone(), now, text: t }),
                      }),
                    ]
                  : undefined
              }
              control={
                isFinishedOnce(task) ? undefined : (
                  <Switch
                    size="sm"
                    checked={task.status === "active"}
                    pending={busy.has(task.id)}
                    onCheckedChange={(on) => void setOn(task, on)}
                    aria-label={t("automations.panel.toggle", { name: task.name })}
                  />
                )
              }
              menu={menu(task)}
              menuLabel={t("automations.panel.menu", { name: task.name })}
              onOpen={() => go({ kind: "detail", taskId: task.id })}
            />
          );
        })}
      </RowList>
    );
  }

  return (
    <TooltipProvider>
      <section
        aria-label={title ?? t("automations.panel.title")}
        className={cn("og-automations flex min-w-0 flex-col gap-4", className)}
      >
        {view.kind === "list" && (title !== null || (tasks?.length ?? 0) > 0) ? (
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {title !== null ? (
                <h2 className="m-0 text-base leading-6 font-semibold text-fg">{title}</h2>
              ) : null}
              {(tasks?.length ?? 0) > 0 ? (
                <p className="m-0 text-sm leading-5 text-fg-muted">
                  {sessionId
                    ? t("automations.panel.descriptionChat")
                    : t("automations.panel.description")}
                </p>
              ) : null}
            </div>
            {(tasks?.length ?? 0) > 0 ? (
              <Button
                type="button"
                size="sm"
                onClick={() => go({ kind: "form", taskId: null })}
                className="pointer-coarse:h-11"
              >
                <PlusIcon aria-hidden="true" />
                {t("automations.panel.new")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {view.kind === "list" ? noticeLine : null}
        {body}
        <ConfirmDialog
          open={deleting !== null}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          title={t("automations.panel.deleteTitle", { name: deleting?.name ?? "" })}
          description={t("automations.panel.deleteBody")}
          confirmLabel={t("automations.panel.deleteConfirm")}
          cancelLabel={t("automations.form.cancel")}
          onConfirm={() => (deleting ? remove(deleting) : true)}
        />
      </section>
    </TooltipProvider>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  const t = useOpenGeniText();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      className="-ml-2 self-start text-fg-muted pointer-coarse:h-11"
    >
      <ChevronLeftIcon aria-hidden="true" />
      {t("automations.panel.back")}
    </Button>
  );
}

function AutomationTile({ task }: { task: ScheduledTask }) {
  return (
    <LogoTile
      name={task.name}
      icon={hasEventTriggers(task) ? <ZapIcon /> : <CalendarClockIcon />}
    />
  );
}

/** Paused or finished: the states a row calls out. */
function showsStatus(task: ScheduledTask): boolean {
  return isFinishedOnce(task) || task.status === "paused";
}

/** Paused or Finished; nothing while it is on. */
function AutomationStatus({ task }: { task: ScheduledTask }) {
  const t = useOpenGeniText();
  if (isFinishedOnce(task))
    return (
      <StatusBadge variant="dot" status="succeeded">
        {t("automations.panel.finished")}
      </StatusBadge>
    );
  if (task.status === "paused")
    return (
      <StatusBadge variant="dot" status="paused">
        {t("automations.panel.paused")}
      </StatusBadge>
    );
  return null;
}

function AutomationDetail({
  client,
  workspaceId,
  task,
  sessionId,
  sources,
  sourceLogo,
  onOpenSession,
  busy,
  startedAt,
  now,
  onBack,
  onSetOn,
  onRunNow,
  onEdit,
  onDelete,
  notice,
}: {
  client: OpenGeniClient;
  workspaceId: string;
  task: ScheduledTask;
  sessionId: string | undefined;
  sources: EventSource[] | undefined;
  sourceLogo: EventSourceLogoResolver | undefined;
  onOpenSession: ((sessionId: string) => void) | undefined;
  busy: boolean;
  /** When Run now last started this automation here. */
  startedAt: number | null;
  now: Date;
  onBack: () => void;
  onSetOn: (on: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** What the last action here said. */
  notice: ReactNode;
}) {
  const t = useOpenGeniText();
  const where =
    task.runMode === "new_session_per_run"
      ? t("automations.panel.whereNewChat")
      : sessionId && task.targetSessionId === sessionId
        ? t("automations.panel.whereChat")
        : t("automations.panel.whereOtherChat");
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <BackButton onClick={onBack} />
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AutomationTile task={task} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h3 className="m-0 text-base leading-6 font-semibold break-words text-fg">
              {task.name}
            </h3>
            {showsStatus(task) ? <AutomationStatus task={task} /> : null}
          </div>
          {isFinishedOnce(task) ? null : (
            <Switch
              checked={task.status === "active"}
              pending={busy}
              onCheckedChange={onSetOn}
              aria-label={t("automations.panel.toggle", { name: task.name })}
              className="shrink-0"
            />
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onRunNow} disabled={busy}>
            <PlayIcon aria-hidden="true" />
            {t("automations.panel.runNow")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            {t("automations.panel.edit")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="ml-auto text-danger"
          >
            {t("automations.panel.delete")}
          </Button>
        </div>
        {notice}
      </div>
      <dl className="m-0 flex min-w-0 flex-col gap-4">
        <DetailItem label={t("automations.panel.when")}>
          <p className="m-0">{automationWhenSentence(t, task, now)}</p>
          {task.events && task.events.triggers.length > 0 ? (
            <EventTriggerSummary
              triggers={task.events.triggers}
              sources={sources}
              sourceLogo={sourceLogo}
            />
          ) : null}
        </DetailItem>
        <DetailItem label={t("automations.panel.where")}>
          <p className="m-0">{where}</p>
        </DetailItem>
        <DetailItem label={t("automations.panel.instructions")}>
          <p className="m-0 line-clamp-6 break-words whitespace-pre-wrap">
            {task.agentConfig.prompt}
          </p>
        </DetailItem>
      </dl>
      <AutomationRuns
        client={client}
        workspaceId={workspaceId}
        task={task}
        startedAt={startedAt}
        onOpenSession={onOpenSession}
      />
    </div>
  );
}

function DetailItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="text-xs leading-4.5 font-medium text-fg-muted">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-col gap-2 text-sm leading-5 text-fg">{children}</dd>
    </div>
  );
}

const RUN_STATUS: Record<ScheduledTaskRun["status"], ProductStatus> = {
  queued: "queued",
  dispatched: "running",
  succeeded: "succeeded",
  skipped: "queued",
  failed: "failed",
};

/** Runs the list shows at once. */
const RUNS_SHOWN = 10;
/** After Run now, the list looks for the new run this often, for this many reads at most. */
const RUN_STARTED_READ_MS = 1_500;
const RUN_STARTED_READS = 20;
/** While a run waits in the queue, the list reads its status this often. */
const RUN_QUEUED_READ_MS = 5_000;

function AutomationRuns({
  client,
  workspaceId,
  task,
  startedAt,
  onOpenSession,
}: {
  client: OpenGeniClient;
  workspaceId: string;
  task: ScheduledTask;
  startedAt: number | null;
  onOpenSession: ((sessionId: string) => void) | undefined;
}) {
  const t = useOpenGeniText();
  const [runs, setRuns] = useState<ScheduledTaskRun[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  // Every settled read, so the next one is scheduled from it.
  const [reads, setReads] = useState(0);
  const [again, setAgain] = useState(0);
  const shown = useRef<ScheduledTaskRun[] | undefined>(undefined);
  useEffect(() => {
    shown.current = runs;
  }, [runs]);
  // Run now starts the run in the background, so the list looks for it until
  // a run that wasn't shown when it was pressed appears. Opened after the
  // press, the list can't tell the new run apart and looks for the rest of the
  // window.
  const [looking, setLooking] = useState<{
    known: ReadonlySet<string> | null;
    reads: number;
  } | null>(null);
  useEffect(() => {
    if (startedAt === null) return;
    const left = RUN_STARTED_READS - Math.floor((Date.now() - startedAt) / RUN_STARTED_READ_MS);
    if (left <= 0) return;
    const known = shown.current;
    setLooking({ known: known ? new Set(known.map((run) => run.id)) : null, reads: left });
  }, [startedAt]);
  // Read again whenever the automation changes, after Run now, and on schedule.
  const revision = task.updatedAt;
  useEffect(() => {
    let live = true;
    setFailed(false);
    client.listScheduledTaskRuns(workspaceId, task.id, { limit: RUNS_SHOWN }).then(
      (list) => {
        if (!live) return;
        setRuns(list);
        setLooking((current) =>
          !current ||
          current.reads <= 1 ||
          (current.known && list.some((run) => !current.known?.has(run.id)))
            ? null
            : { ...current, reads: current.reads - 1 },
        );
        setReads((count) => count + 1);
      },
      () => {
        if (!live) return;
        setFailed(true);
        setReads((count) => count + 1);
      },
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId, task.id, revision, startedAt, again]);
  const queued = runs?.some((run) => run.status === "queued") ?? false;
  useEffect(() => {
    if (reads === 0 || (!looking && !queued)) return;
    const timer = setTimeout(
      () => setAgain((count) => count + 1),
      looking ? RUN_STARTED_READ_MS : RUN_QUEUED_READ_MS,
    );
    return () => clearTimeout(timer);
  }, [reads, looking, queued]);
  const headingId = `${task.id}-runs`;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h4 id={headingId} className="m-0 text-xs leading-4.5 font-medium text-fg-muted">
        {t("automations.panel.runs")}
      </h4>
      {failed && !runs ? (
        <p className="m-0 text-sm leading-5 text-fg-muted">{t("automations.panel.runsFailed")}</p>
      ) : !runs ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : runs.length === 0 ? (
        <p className="m-0 text-sm leading-5 text-fg-muted">{t("automations.panel.runsEmpty")}</p>
      ) : (
        <ul className="m-0 flex min-w-0 list-none flex-col p-0">
          {runs.map((run) => {
            const cause =
              run.triggerType === "event"
                ? (automationRunEventsLabel(t, run) ??
                  automationRunTriggerLabel(t, run.triggerType))
                : automationRunTriggerLabel(t, run.triggerType);
            return (
              <li
                key={run.id}
                className="flex min-w-0 items-center gap-3 border-t border-border py-2.5 first:border-t-0 first:pt-1"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm leading-5 text-fg" title={cause}>
                    {cause}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs leading-4.5 text-fg-muted">
                    <StatusBadge
                      variant="dot"
                      status={RUN_STATUS[run.status]}
                      className={cn("shrink-0", run.status === "failed" && "text-danger")}
                    >
                      {automationRunStatusLabel(t, run.status)}
                    </StatusBadge>
                    <span aria-hidden="true">·</span>
                    <RelativeTime date={run.firedAt} />
                  </span>
                  {run.status === "failed" && run.error ? (
                    <span className="line-clamp-2 text-xs leading-4.5 break-words text-fg-muted">
                      {run.error}
                    </span>
                  ) : null}
                </span>
                {run.sessionId && onOpenSession ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenSession(run.sessionId!)}
                    className="shrink-0"
                  >
                    {t("automations.panel.openChat")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
