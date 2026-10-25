/**
 * Automations as people read and edit them: when one runs in words, its next
 * run, the name it gets when none is typed, and the draft a form edits with
 * the create and update requests it becomes. Pure; the Automations panel and
 * the web app's Automations pages share it. Words come from the host's message
 * catalog, so each function that returns text takes the `t` of
 * `useOpenGeniText()` first.
 */
import type {
  CreateScheduledTaskRequest,
  EventSource,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskScheduleSpec,
  UpdateScheduledTaskRequest,
} from "@opengeni/sdk";

import type { OpenGeniMessageKey, OpenGeniText } from "../../messages/runtime";
import { inSentence } from "../../ui/relative-time";
import {
  sessionAutomationWait,
  sessionAutomationWaitLabel,
  type SessionAutomationWait,
  type SessionListRow,
} from "../../session-list-model";
import {
  DEFAULT_CADENCE_TIME,
  cadenceFromScheduleSpec,
  describeCadence,
  formatRunTime,
  nextRuns,
  toScheduleSpec,
  validateCadence,
  type CadenceScheduleSpec,
  type CadenceValue,
} from "../../ui/cadence-picker";
import {
  emptyEventTriggersDraft,
  eventTriggersDraftFrom,
  eventTriggersInputFrom,
  eventTriggersShortLabel,
  eventTypesLabel,
  hasEventTriggerIssues,
  sameEventTriggers,
  validateEventTriggers,
  type EventTriggersDraft,
  type EventTriggersIssues,
} from "./event-trigger-model";

/* ----------------------------------------------------------------------------
   Schedules.
   -------------------------------------------------------------------------- */

/** The viewer's IANA time zone, or UTC when the runtime can't tell. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "Every weekday at 09:00, your time": where a new schedule starts. */
export function defaultAutomationCadence(timeZone: string = viewerTimeZone()): CadenceValue {
  return { timeZone, rule: { frequency: "weekdays", time: DEFAULT_CADENCE_TIME } };
}

/** A stored schedule as an editable cadence; null when it has none (events or Run now only). */
export function automationCadence(
  schedule: ScheduledTaskScheduleSpec,
  fallbackTimeZone: string = viewerTimeZone(),
): CadenceValue | null {
  if (schedule.type === "manual") return null;
  try {
    return cadenceFromScheduleSpec(
      schedule as unknown as CadenceScheduleSpec,
      "timeZone" in schedule && schedule.timeZone ? schedule.timeZone : fallbackTimeZone,
    );
  } catch {
    return null;
  }
}

/** The stored schedule for a cadence; no cadence stores `{ type: "manual" }`. */
export function automationScheduleSpec(
  cadence: CadenceValue | null,
  now: Date,
): ScheduledTaskScheduleSpec {
  if (!cadence) return { type: "manual" };
  return toScheduleSpec(cadence.rule, {
    timeZone: cadence.timeZone,
    now,
  }) as unknown as ScheduledTaskScheduleSpec;
}

export interface AutomationScheduleWords {
  /** "Every weekday at 08:00 · Oslo", for rows and meta lines. */
  short: string;
  /** "Runs every weekday at 08:00 Oslo time", for sentences (no full stop). */
  sentence: string;
}

/** A cadence in words. */
export function automationCadenceWords(
  t: OpenGeniText,
  cadence: CadenceValue,
  now: Date,
): AutomationScheduleWords {
  const words = describeCadence(cadence.rule, { timeZone: cadence.timeZone, now, text: t });
  return { short: words.short, sentence: words.sentence };
}

/** A stored schedule in words; one without a cadence runs only with Run now. */
export function automationScheduleWords(
  t: OpenGeniText,
  schedule: ScheduledTaskScheduleSpec,
  now: Date,
): AutomationScheduleWords {
  const cadence = automationCadence(schedule);
  if (!cadence) {
    return { short: t("automations.when.manual"), sentence: t("automations.when.manualSentence") };
  }
  return automationCadenceWords(t, cadence, now);
}

/** Whether a schedule problem stops the cadence from saving, in words; null when it saves. */
export function automationCadenceIssue(
  t: OpenGeniText,
  cadence: CadenceValue | null,
  now: Date,
): string | null {
  if (!cadence) return null;
  return (
    validateCadence(cadence.rule, { timeZone: cadence.timeZone, now, text: t })?.message ?? null
  );
}

/** The cadence runs more than once; a run-once automation can't have one. */
export function automationCadenceRepeats(cadence: CadenceValue | null): boolean {
  return cadence !== null && cadence.rule.frequency !== "once";
}

/* ----------------------------------------------------------------------------
   State.
   -------------------------------------------------------------------------- */

type AutomationState = Pick<ScheduledTask, "status" | "schedule" | "events">;

/** It has event triggers, so events can start it. */
export function hasEventTriggers(task: Pick<ScheduledTask, "events">): boolean {
  return (task.events?.triggers.length ?? 0) > 0;
}

/** A run-once automation whose run happened: it no longer listens or runs. */
export function isFinishedOnce(task: Pick<ScheduledTask, "events">): boolean {
  return Boolean(task.events?.once && task.events.completedAt);
}

/** Its next scheduled run, or null when it is paused, finished, or has no schedule or runs left. */
export function automationNextRun(task: AutomationState, now: Date): Date | null {
  if (task.status !== "active" || isFinishedOnce(task)) return null;
  const cadence = automationCadence(task.schedule);
  if (!cadence) return null;
  return nextRuns(cadence.rule, { timeZone: cadence.timeZone, now, count: 1 })[0] ?? null;
}

/** Events can start it now: it is on, has triggers and has not finished. */
export function automationListensForEvents(task: AutomationState): boolean {
  return task.status === "active" && hasEventTriggers(task) && !isFinishedOnce(task);
}

/** An agent automation, as opposed to a knowledge source sync. */
export function isAgentAutomation(
  task: Pick<ScheduledTask, "action"> & { agentConfig?: { knowledgeSource?: unknown } },
): boolean {
  return task.action?.kind !== "knowledge_source_sync" && !task.agentConfig?.knowledgeSource;
}

/**
 * Scheduled ones by next run (soonest first), then those waiting for events,
 * then everything that won't fire (paused, finished, Run now only) by name.
 */
export function sortAutomations<Task extends AutomationState & Pick<ScheduledTask, "name">>(
  tasks: readonly Task[],
  now: Date,
): Task[] {
  const keyed = tasks.map((task) => ({
    task,
    next: automationNextRun(task, now)?.getTime() ?? null,
    listening: automationListensForEvents(task),
  }));
  const rank = (entry: (typeof keyed)[number]) =>
    entry.next !== null ? 0 : entry.listening ? 1 : 2;
  keyed.sort((left, right) => {
    if (rank(left) !== rank(right)) return rank(left) - rank(right);
    if (left.next !== null && right.next !== null && left.next !== right.next)
      return left.next - right.next;
    return left.task.name.localeCompare(right.task.name);
  });
  return keyed.map((entry) => entry.task);
}

/* ----------------------------------------------------------------------------
   Words.
   -------------------------------------------------------------------------- */

/**
 * When it runs, in one line: "Every weekday at 08:00 · Oslo",
 * "pull_request.opened from GitHub", or both.
 */
export function automationWhenWords(
  t: OpenGeniText,
  task: Pick<ScheduledTask, "schedule" | "events">,
  sources: readonly Pick<EventSource, "id" | "name">[],
  now: Date,
): string {
  const events = eventTriggersShortLabel(t, task.events?.triggers ?? [], sources);
  if (!events) return automationScheduleWords(t, task.schedule, now).short;
  if (task.schedule.type === "manual") return events;
  return t("automations.when.scheduleAndEvents", {
    schedule: automationScheduleWords(t, task.schedule, now).short,
    events,
  });
}

/**
 * When it runs, as a sentence: "Runs every weekday at 08:00 Oslo time, and
 * when a matching event arrives.", or "Runs once, on the first matching event."
 */
export function automationWhenSentence(
  t: OpenGeniText,
  task: Pick<ScheduledTask, "schedule" | "events">,
  now: Date,
): string {
  const words = automationScheduleWords(t, task.schedule, now).sentence;
  if (!hasEventTriggers(task)) return t("automations.when.sentence", { words });
  if (task.schedule.type !== "manual") return t("automations.when.sentenceWithEvents", { words });
  return task.events?.once ? t("automations.when.onceOnEvent") : t("automations.when.onEvent");
}

/**
 * The events a run carried, in a few words: the first event's summary and how
 * many more came with it. Null for a run no event started.
 */
export function automationRunEventsLabel(
  t: OpenGeniText,
  run: Pick<ScheduledTaskRun, "eventOccurrence">,
): string | null {
  const occurrence = run.eventOccurrence;
  if (!occurrence || occurrence.eventCount === 0) return null;
  const [first] = occurrence.events;
  if (!first) return t("automations.runEvents.count", { count: occurrence.eventCount });
  const what = first.summary ?? first.subject ?? first.type;
  return occurrence.eventCount === 1
    ? what
    : t("automations.runEvents.firstAndMore", { first: what, count: occurrence.eventCount - 1 });
}

/** A run's outcome in a word: "Done", "Failed". */
export function automationRunStatusLabel(
  t: OpenGeniText,
  status: ScheduledTaskRun["status"],
): string {
  switch (status) {
    case "queued":
      return t("automations.run.status.queued");
    case "dispatched":
      return t("automations.run.status.dispatched");
    case "succeeded":
      return t("automations.run.status.succeeded");
    case "skipped":
      return t("automations.run.status.skipped");
    case "failed":
      return t("automations.run.status.failed");
  }
}

/** What started a run: "On schedule", "Run now", "Event". */
export function automationRunTriggerLabel(
  t: OpenGeniText,
  triggerType: ScheduledTaskRun["triggerType"],
): string {
  switch (triggerType) {
    case "scheduled":
      return t("automations.run.trigger.scheduled");
    case "manual":
      return t("automations.run.trigger.manual");
    case "initial":
      return t("automations.run.trigger.initial");
    case "provider_event":
      return t("automations.run.trigger.providerEvent");
    case "event":
      return t("automations.run.trigger.event");
    case "retry":
      return t("automations.run.trigger.retry");
    case "repair":
      return t("automations.run.trigger.repair");
  }
}

type RunErrorKey = Extract<OpenGeniMessageKey, `automations.run.error.${string}`>;

/** The recorded reason codes of failed and skipped runs, by what a person reads. */
const RUN_ERROR_KEYS: Readonly<Record<string, RunErrorKey>> = {
  scheduled_turn_failed: "automations.run.error.turnFailed",
  scheduled_update_failed: "automations.run.error.turnFailed",
  scheduled_turn_cancelled: "automations.run.error.turnStopped",
  scheduled_update_cancelled: "automations.run.error.turnStopped",
  scheduled_turn_superseded: "automations.run.error.turnInterrupted",
  scheduled_update_superseded: "automations.run.error.turnInterrupted",
  scheduled_turn_withdrawn_for_edit: "automations.run.error.turnWithdrawn",
  scheduled_session_not_idle: "automations.run.error.chatBusy",
  scheduled_session_paused: "automations.run.error.chatPaused",
  session_cancelled: "automations.run.error.chatEnded",
  scheduled_target_session_unavailable: "automations.run.error.chatGone",
  scheduled_target_execution_changed: "automations.run.error.chatChanged",
  scheduled_workspace_paused: "automations.run.error.workspacePaused",
  scheduled_task_paused_before_claim: "automations.run.error.automationInactive",
  scheduled_task_deleted_before_claim: "automations.run.error.automationInactive",
  scheduled_task_inactive_before_claim: "automations.run.error.automationInactive",
  scheduled_machine_unavailable: "automations.run.error.machineUnavailable",
  machine_target_unavailable: "automations.run.error.machineUnavailable",
  machine_enrollment_inactive: "automations.run.error.machineUnavailable",
  scheduled_authority_unavailable: "automations.run.error.accessUnavailable",
  scheduled_authority_exhausted: "automations.run.error.accessUnavailable",
  scheduled_authority_snapshot_missing: "automations.run.error.accessUnavailable",
  connection_account_unavailable: "automations.run.error.accountUnavailable",
  scheduled_model_unavailable: "automations.run.error.modelUnavailable",
  variable_set_unavailable: "automations.run.error.variableSetUnavailable",
  rig_version_unavailable: "automations.run.error.rigUnavailable",
  insufficient_credits: "automations.run.error.outOfCredits",
  allowance_exhausted: "automations.run.error.allowanceUsed",
  monthly_model_cost_limit: "automations.run.error.monthlyCostLimit",
  monthly_agent_run_limit: "automations.run.error.monthlyRunLimit",
  session_usage_limit: "automations.run.error.usageLimit",
};

/** Older runs recorded an unavailable model as the API's own sentence. */
const MODEL_UNAVAILABLE_TEXT =
  /^(?:model is not available: .+|Turn execution policy model is (?:not present in the configured catalog|retired from new selection|no longer configured))$/;

const REASON_CODE = /^[a-z][a-z0-9_]*$/;

/**
 * Why a run failed or was skipped, as a sentence for people: "Skipped because
 * the chat was still busy with earlier work." Runs record a reason code; a
 * code this version doesn't know reads as a plain "something went wrong", never
 * as the code. An error recorded as a sentence passes through.
 */
export function automationRunErrorText(t: OpenGeniText, error: string): string {
  const trimmed = error.trim();
  const key = Object.hasOwn(RUN_ERROR_KEYS, trimmed) ? RUN_ERROR_KEYS[trimmed] : undefined;
  if (key) return t(key);
  if (MODEL_UNAVAILABLE_TEXT.test(trimmed)) return t("automations.run.error.modelUnavailable");
  if (!trimmed || REASON_CODE.test(trimmed)) return t("automations.run.error.unknown");
  return trimmed;
}

/* ----------------------------------------------------------------------------
   Names.
   -------------------------------------------------------------------------- */

export const AUTOMATION_NAME_MAX_LENGTH = 80;

const DANGLING_WORD = /\s+(a|an|and|at|by|for|from|in|into|of|on|or|the|to|with)$/i;
const DERIVED_NAME_LIMIT = 60;

/**
 * The name an automation gets when none is typed: the first sentence of the
 * instructions, without a leading "Every weekday at 08:00:" and at most 60
 * characters, ending on a word that carries meaning.
 */
export function deriveAutomationName(instructions: string): string {
  const withoutCadence = instructions.trim().replace(/^every\b.{0,40}?:\s+/i, "");
  const firstSentence = withoutCadence.split(/(?<=[.!?])\s|\n/)[0]?.replace(/[.!?]$/, "") ?? "";
  const clean = firstSentence.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const capitalized = clean.charAt(0).toLocaleUpperCase() + clean.slice(1);
  if (capitalized.length <= DERIVED_NAME_LIMIT) return capitalized;
  let cut = capitalized.slice(0, DERIVED_NAME_LIMIT);
  const space = cut.lastIndexOf(" ");
  if (space > 20) cut = cut.slice(0, space);
  cut = cut.replace(/[,;:]$/, "");
  while (DANGLING_WORD.test(cut)) cut = cut.replace(DANGLING_WORD, "");
  return `${cut}…`;
}

/* ----------------------------------------------------------------------------
   The draft.
   -------------------------------------------------------------------------- */

/** What the Automations panel's form edits. */
export interface AutomationDraft {
  /** What the agent does on each run. */
  instructions: string;
  /** Empty: named after the instructions. */
  name: string;
  /** Null when it runs only on events or with Run now. */
  cadence: CadenceValue | null;
  /** Its event triggers and their run policy; no triggers when it runs on a schedule only. */
  events: EventTriggersDraft;
}

/** Where a new automation's runs go: on in one chat, or a new chat each run. */
export type AutomationDestination = { kind: "chat"; sessionId: string } | { kind: "new_chat" };

/** A blank draft. Without a `cadence` option it starts on the default schedule. */
export function newAutomationDraft(
  options: { cadence?: CadenceValue | null } = {},
): AutomationDraft {
  return {
    instructions: "",
    name: "",
    cadence: options.cadence === undefined ? defaultAutomationCadence() : options.cadence,
    events: emptyEventTriggersDraft(),
  };
}

/** The draft of a saved automation. */
export function automationDraftFrom(
  task: Pick<ScheduledTask, "name" | "schedule" | "events" | "agentConfig">,
): AutomationDraft {
  return {
    instructions: task.agentConfig.prompt,
    name: task.name,
    cadence: automationCadence(task.schedule),
    events: eventTriggersDraftFrom(task.events),
  };
}

/** The name it saves with: the typed one, else one from the instructions. */
export function automationName(
  t: OpenGeniText,
  draft: Pick<AutomationDraft, "name" | "instructions">,
): string {
  return (
    draft.name.trim() || deriveAutomationName(draft.instructions) || t("automations.name.untitled")
  );
}

export interface AutomationDraftIssues {
  instructions?: string | undefined;
  name?: string | undefined;
  /** The schedule can't be saved as it is. */
  cadence?: string | undefined;
  /** The schedule and events don't fit together. */
  when?: string | undefined;
  events?: EventTriggersIssues | undefined;
}

export function validateAutomationDraft(
  t: OpenGeniText,
  draft: AutomationDraft,
  sources: readonly Pick<EventSource, "id" | "kind">[],
  now: Date,
): AutomationDraftIssues {
  const issues: AutomationDraftIssues = {};
  if (!draft.instructions.trim()) issues.instructions = t("automations.issue.instructions");
  if (draft.name.trim().length > AUTOMATION_NAME_MAX_LENGTH)
    issues.name = t("automations.issue.nameTooLong", { max: AUTOMATION_NAME_MAX_LENGTH });
  const cadence = automationCadenceIssue(t, draft.cadence, now);
  if (cadence) issues.cadence = cadence;
  if (
    draft.events.once &&
    draft.events.triggers.length > 0 &&
    automationCadenceRepeats(draft.cadence)
  )
    issues.when = t("automations.issue.onceRepeats");
  if (draft.events.triggers.length > 0) {
    const events = validateEventTriggers(t, draft.events, sources);
    if (hasEventTriggerIssues(events)) issues.events = events;
  }
  return issues;
}

export function hasAutomationDraftIssues(issues: AutomationDraftIssues): boolean {
  return Object.values(issues).some(Boolean);
}

/** The `events` of a create request: present only with triggers. */
function eventsForCreate(draft: AutomationDraft) {
  return draft.events.triggers.length > 0 ? { events: eventTriggersInputFrom(draft.events) } : {};
}

/**
 * The create request for a draft. One that continues a chat posts the
 * instructions there and runs with that chat's settings; one that starts a new
 * chat each run follows the workspace's default tools and machine at each run,
 * like a new chat, with the owner's access. Nothing is scoped down unless a
 * person chooses to elsewhere.
 */
export function automationCreateRequest(
  t: OpenGeniText,
  draft: AutomationDraft,
  destination: AutomationDestination,
  now: Date,
): CreateScheduledTaskRequest {
  const name = automationName(t, draft);
  const schedule = automationScheduleSpec(draft.cadence, now);
  const prompt = draft.instructions.trim();
  if (destination.kind === "chat") {
    return {
      name,
      schedule,
      prompt,
      targetSessionId: destination.sessionId,
      overlapPolicy: "buffer_one",
      ...eventsForCreate(draft),
    };
  }
  return {
    name,
    schedule,
    runMode: "new_session_per_run",
    agentConfig: {
      prompt,
      resources: [],
      tools: [],
      toolPolicy: { mode: "workspace_default", excludedMcpServerIds: [] },
      executionTarget: "workspace_default",
      metadata: {},
    },
    ...eventsForCreate(draft),
  };
}

/**
 * The PATCH for an edited draft: only what changed. Instructions use the
 * lossless `prompt` edit, so settings the form doesn't show stay as saved.
 */
export function automationUpdateRequest(
  t: OpenGeniText,
  initial: AutomationDraft,
  draft: AutomationDraft,
  now: Date,
): UpdateScheduledTaskRequest {
  const name = automationName(t, draft);
  return {
    ...(automationName(t, initial) === name ? {} : { name }),
    ...(initial.instructions.trim() === draft.instructions.trim()
      ? {}
      : { prompt: draft.instructions.trim() }),
    ...(JSON.stringify(initial.cadence) === JSON.stringify(draft.cadence)
      ? {}
      : { schedule: automationScheduleSpec(draft.cadence, now) }),
    // Triggers are sent whole, and only when they changed; none removes them all.
    ...(sameEventTriggers(initial.events, draft.events)
      ? {}
      : {
          events:
            draft.events.triggers.length > 0
              ? eventTriggersInputFrom(draft.events)
              : { triggers: [] },
        }),
  };
}

/* ----------------------------------------------------------------------------
   What a chat waits for.
   -------------------------------------------------------------------------- */

export interface SessionAutomationWaitWords {
  /** An event can start a run (it wins when both apply), or only the schedule will. */
  kind: SessionAutomationWait;
  /**
   * A sentence for a tooltip or hover card: "Waiting for deploy.finished from
   * Deploys", "Next run: Tomorrow, 09:00", both, and how many more automations
   * wait. Servers without the details get the plain "Waiting for an event".
   */
  label: string;
  /** A few words for a chip: "Waiting on Deploys", "Next: Tomorrow, 09:00". */
  short: string;
}

/**
 * What the automations posting into a chat are waiting for, in words, or null
 * when none of them will start a run. Times are in `timeZone` (the viewer's).
 */
export function sessionAutomationWaitWords(
  t: OpenGeniText,
  session: Pick<
    SessionListRow,
    "hasSchedules" | "hasUpcomingSchedules" | "waitingForEvents" | "automationWait"
  >,
  { now, timeZone = viewerTimeZone() }: { now: Date; timeZone?: string },
): SessionAutomationWaitWords | null {
  const summary = session.automationWait;
  // The details cover only automations this person can see; without them the
  // plain facts still say a chat waits on someone else's Only me automation.
  const kind: SessionAutomationWait | null = summary
    ? summary.event
      ? "event"
      : "schedule"
    : sessionAutomationWait(session);
  if (!kind) return null;
  if (!summary) {
    const label = sessionAutomationWaitLabel(t, kind);
    return {
      kind,
      label,
      short: kind === "event" ? t("automations.wait.chip.anyEvent") : label,
    };
  }
  const source = summary.event?.source?.name ?? null;
  const types = summary.event ? eventTypesLabel(t, summary.event.eventTypes) : null;
  const event =
    summary.event && types
      ? t("automations.trigger.short", {
          // "Every event" reads "every event" mid-sentence; event names keep their case.
          events: summary.event.eventTypes[0]?.endsWith("*") ? inSentence(types, t) : types,
          source: source ?? t("automations.trigger.hiddenSourceInline"),
        })
      : null;
  const time = summary.nextRunAt
    ? formatRunTime(new Date(summary.nextRunAt), { timeZone, now, text: t })
    : null;
  const wait =
    event && time
      ? t("automations.wait.eventOrNextRun", { event, time })
      : event
        ? t("automations.wait.eventFrom", { event })
        : time
          ? t("automations.wait.nextRun", { time })
          : sessionAutomationWaitLabel(t, kind);
  const more = summary.automations - 1;
  return {
    kind,
    label: more > 0 ? t("automations.wait.more", { wait, count: more }) : wait,
    short:
      kind === "event"
        ? source
          ? t("automations.wait.chip.event", { source })
          : t("automations.wait.chip.anyEvent")
        : time
          ? t("automations.wait.chip.nextRun", { time })
          : sessionAutomationWaitLabel(t, kind),
  };
}
