import { localDateTimeValue, formatTimestamp } from "@/lib/format";
import type {
  ReasoningEffort,
  ResourceRef,
  SandboxBackend,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  ScheduledTaskRun,
  ScheduledTaskScheduleSpec,
} from "@/types";

type CalendarSchedule = Extract<ScheduledTaskScheduleSpec, { type: "calendar" }>;
export type ScheduledTaskCalendarDay = NonNullable<CalendarSchedule["daysOfWeek"]>[number];

/**
 * Canonical day order. The contract declares the enum Sunday-first and the API
 * hands that array to Temporal unchanged, so both the label and the picker
 * render that order instead of inventing a locale-specific week start.
 */
export const CALENDAR_DAY_ORDER = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const satisfies readonly ScheduledTaskCalendarDay[];

export const CALENDAR_DAY_LABEL: Record<ScheduledTaskCalendarDay, string> = {
  SUNDAY: "Sun",
  MONDAY: "Mon",
  TUESDAY: "Tue",
  WEDNESDAY: "Wed",
  THURSDAY: "Thu",
  FRIDAY: "Fri",
  SATURDAY: "Sat",
};

const SCHEDULE_DESCRIPTION_METADATA_KEY = "scheduleDescription";
export const SCHEDULE_DESCRIPTION_MAX_LENGTH = 2_000;

export type ScheduledTaskCadence = "once" | "hourly" | "daily" | "weekly" | "interval";

/**
 * Deduplicated selection in canonical order. Every day fact in this module -
 * the label, the form state, and the spec written back - goes through here, so
 * a stored `["FRIDAY","MONDAY"]` and a stored `["MONDAY","FRIDAY"]` cannot
 * round-trip into two different-looking schedules that fire identically.
 * An empty result means "no day filter", which is what Temporal does with no
 * `dayOfWeek` entry and what the contract expresses by omitting the field.
 */
export function normalizeCalendarDays(
  days: readonly ScheduledTaskCalendarDay[] | undefined,
): ScheduledTaskCalendarDay[] {
  return CALENDAR_DAY_ORDER.filter((day) => days?.includes(day));
}

export type ScheduledTaskFormState = {
  name: string;
  description: string;
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  scheduleType: "once" | "interval" | "calendar";
  runAt: string;
  intervalMinutes: number;
  calendarTime: string;
  /**
   * Days a calendar schedule fires on, empty meaning every day. Carried in form
   * state even when the editor is not showing the picker: dropping it on the
   * way in silently rewrote a Mon/Wed/Fri schedule to daily on the next save.
   */
  calendarDaysOfWeek: ScheduledTaskCalendarDay[];
  timeZone: string;
  runMode: ScheduledTask["runMode"];
  targetSessionId: string;
  executionTarget: "managed" | "machine";
  sandboxBackend: SandboxBackend | "";
  machineSandboxId: string;
  workingDir: string;
  overlapPolicy: ScheduledTask["overlapPolicy"];
  includeOpenGeniTool: boolean;
  slackBotConnectionId: string;
  resources: ResourceRef[];
};

/**
 * Runs for every row before the list is even grouped, so it reads `action` and
 * `metadata` defensively: this is a list read, and one malformed row must not
 * take the page down on the way to being rendered as one degraded card.
 */
export function scheduledTaskStateLabel(task: ScheduledTask): {
  label: string;
  active: boolean;
  reason: "active" | "user_paused" | "connection_paused" | "source_disabled";
} {
  if (task.status === "paused") {
    return { label: "Paused", active: false, reason: "user_paused" };
  }
  if (task.action?.kind === "knowledge_source_sync") {
    const value = task.metadata?.knowledgeSourceSync;
    if (value && typeof value === "object") {
      const control = value as Record<string, unknown>;
      if (control.sourceEnabled === false) {
        return {
          label: "Sync disabled",
          active: false,
          reason: "source_disabled",
        };
      }
      if (control.connectionPaused === true) {
        return {
          label: "Connection paused",
          active: false,
          reason: "connection_paused",
        };
      }
    }
  }
  return { label: "Active", active: true, reason: "active" };
}

export function newScheduledTaskFormState(
  includeOpenGeniTool: boolean,
  resources: ResourceRef[] = [],
  defaults: {
    model?: string;
    reasoningEffort?: ReasoningEffort;
    defaultSandboxBackend?: SandboxBackend;
    defaultMachineSandboxId?: string;
  } = {},
): ScheduledTaskFormState {
  const machineDefault = defaults.defaultSandboxBackend === "selfhosted";
  return {
    name: "",
    description: "",
    prompt: "",
    model: defaults.model ?? "",
    reasoningEffort: defaults.reasoningEffort ?? "high",
    scheduleType: "once",
    runAt: localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000)),
    intervalMinutes: 60,
    calendarTime: "09:00",
    calendarDaysOfWeek: [],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    runMode: "new_session_per_run",
    targetSessionId: "",
    executionTarget: machineDefault ? "machine" : "managed",
    sandboxBackend: "",
    machineSandboxId: machineDefault ? (defaults.defaultMachineSandboxId ?? "") : "",
    workingDir: "",
    overlapPolicy: "allow_concurrent",
    includeOpenGeniTool,
    slackBotConnectionId: "",
    resources,
  };
}

/**
 * Explicit editor defaults for a Slack-originated "Make recurring" launch.
 * The source session remains the authority for prior conversation context; no
 * Slack text is copied into the URL or silently persisted as a new prompt.
 */
export function recurringSessionTaskFormState(
  sessionId: string,
  includeOpenGeniTool: boolean,
  defaults: {
    model?: string;
    reasoningEffort?: ReasoningEffort;
    defaultSandboxBackend?: SandboxBackend;
    defaultMachineSandboxId?: string;
  } = {},
): ScheduledTaskFormState {
  return {
    ...newScheduledTaskFormState(includeOpenGeniTool, [], defaults),
    name: "Recurring Slack task",
    prompt: "Continue this task using the current session context and report the result.",
    scheduleType: "interval",
    intervalMinutes: 60,
    runMode: "existing_session",
    targetSessionId: sessionId,
    overlapPolicy: "skip",
  };
}

export function formStateFromScheduledTask(
  task: ScheduledTask,
  defaults: {
    model?: string;
    reasoningEffort?: ReasoningEffort;
    defaultSandboxBackend?: SandboxBackend;
    defaultMachineSandboxId?: string;
  } = {},
): ScheduledTaskFormState {
  const schedule = task.schedule;
  const base = newScheduledTaskFormState(
    task.agentConfig.tools.some((tool) => tool.kind === "mcp" && tool.id === "opengeni"),
    task.agentConfig.resources,
    defaults,
  );
  if (schedule.type === "interval") {
    base.scheduleType = "interval";
    base.intervalMinutes = Math.max(1, Math.round(schedule.everySeconds / 60));
  } else if (schedule.type === "calendar") {
    base.scheduleType = "calendar";
    base.calendarTime = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
    base.calendarDaysOfWeek = normalizeCalendarDays(schedule.daysOfWeek);
    base.timeZone = schedule.timeZone;
  } else if (schedule.type === "once") {
    base.scheduleType = "once";
    base.runAt = localDateTimeValue(new Date(schedule.runAt));
    base.timeZone = schedule.timeZone ?? base.timeZone;
  } else {
    base.scheduleType = "interval";
    base.intervalMinutes = 60;
  }
  return {
    ...base,
    name: task.name,
    description: scheduledTaskDescription(task),
    prompt: task.agentConfig.prompt,
    model: task.agentConfig.model ?? defaults.model ?? "",
    reasoningEffort: task.agentConfig.reasoningEffort ?? defaults.reasoningEffort ?? "high",
    runMode: task.runMode,
    targetSessionId: task.targetSessionId ?? "",
    executionTarget:
      task.agentConfig.machineTarget || task.agentConfig.sandboxBackend === "selfhosted"
        ? "machine"
        : "managed",
    sandboxBackend:
      task.agentConfig.sandboxBackend && task.agentConfig.sandboxBackend !== "selfhosted"
        ? task.agentConfig.sandboxBackend
        : "",
    machineSandboxId: task.agentConfig.machineTarget?.targetSandboxId ?? "",
    workingDir: task.agentConfig.machineTarget?.workingDir ?? "",
    overlapPolicy: task.overlapPolicy,
    slackBotConnectionId: task.agentConfig.slackBotConnectionId ?? "",
  };
}

/** Human-facing summary stored alongside, but never mixed into, agent instructions. */
export function scheduledTaskDescription(task: ScheduledTask): string {
  const value = task.metadata?.[SCHEDULE_DESCRIPTION_METADATA_KEY];
  return typeof value === "string" ? value : "";
}

/** Preserve every non-UI metadata fact while updating the optional description. */
export function taskMetadataFromFormState(
  form: ScheduledTaskFormState,
  existingTask?: ScheduledTask,
): Record<string, unknown> {
  const metadata = { ...(existingTask?.metadata ?? {}) };
  const description = form.description.trim();
  if (description) {
    metadata[SCHEDULE_DESCRIPTION_METADATA_KEY] = description;
  } else {
    delete metadata[SCHEDULE_DESCRIPTION_METADATA_KEY];
  }
  return metadata;
}

/** The clean preset that exactly describes the current wire schedule. */
export function scheduledTaskCadence(form: ScheduledTaskFormState): ScheduledTaskCadence {
  if (form.scheduleType === "once") return "once";
  if (form.scheduleType === "interval") {
    return form.intervalMinutes === 60 ? "hourly" : "interval";
  }
  const days = normalizeCalendarDays(form.calendarDaysOfWeek);
  if (days.length === 0 || days.length === CALENDAR_DAY_ORDER.length) return "daily";
  return "weekly";
}

/** Apply one preset without discarding unrelated form or execution settings. */
export function applyScheduledTaskCadence(
  form: ScheduledTaskFormState,
  cadence: ScheduledTaskCadence,
): ScheduledTaskFormState {
  if (cadence === "once") return { ...form, scheduleType: "once" };
  if (cadence === "hourly") {
    return { ...form, scheduleType: "interval", intervalMinutes: 60 };
  }
  if (cadence === "daily") {
    return { ...form, scheduleType: "calendar", calendarDaysOfWeek: [] };
  }
  if (cadence === "weekly") {
    const selected = normalizeCalendarDays(form.calendarDaysOfWeek);
    return {
      ...form,
      scheduleType: "calendar",
      calendarDaysOfWeek:
        selected.length > 0 && selected.length < CALENDAR_DAY_ORDER.length ? selected : ["MONDAY"],
    };
  }
  return {
    ...form,
    scheduleType: "interval",
    intervalMinutes: form.scheduleType === "interval" ? form.intervalMinutes : 30,
  };
}

/**
 * Whole form state in, one spec out. Deliberately not a positional argument
 * list: the calendar branch quietly lost `daysOfWeek` while the caller kept
 * passing the same five values, and every field a schedule carries has to be
 * visible here for that to stay impossible.
 */
export function scheduleFromFormState(form: ScheduledTaskFormState): ScheduledTaskScheduleSpec {
  if (form.scheduleType === "interval") {
    return {
      type: "interval",
      everySeconds: Math.max(60, Math.round(form.intervalMinutes * 60)),
    };
  }
  if (form.scheduleType === "calendar") {
    const [hourRaw, minuteRaw] = form.calendarTime.split(":");
    const daysOfWeek = normalizeCalendarDays(form.calendarDaysOfWeek);
    return {
      type: "calendar",
      timeZone: form.timeZone,
      hour: Number(hourRaw ?? 9),
      minute: Number(minuteRaw ?? 0),
      // Omitted rather than sent empty: the contract requires at least one day
      // when the field is present, and no filter is exactly "every day".
      ...(daysOfWeek.length > 0 ? { daysOfWeek } : {}),
    };
  }
  return {
    type: "once",
    runAt: new Date(form.runAt).toISOString(),
    timeZone: form.timeZone,
  };
}

export function agentConfigFromFormState(
  form: ScheduledTaskFormState,
  existingTask?: ScheduledTask,
): ScheduledTaskAgentConfig {
  const tools = (existingTask?.agentConfig.tools ?? []).filter(
    (tool) => !(tool.kind === "mcp" && tool.id === "opengeni"),
  );
  if (form.includeOpenGeniTool) {
    tools.push({ kind: "mcp", id: "opengeni" });
  }
  return {
    prompt: form.prompt.trim(),
    resources: form.resources,
    tools,
    metadata: existingTask?.agentConfig.metadata ?? {},
    ...(form.slackBotConnectionId ? { slackBotConnectionId: form.slackBotConnectionId } : {}),
    ...(form.model ? { model: form.model } : {}),
    reasoningEffort: form.reasoningEffort,
    ...(form.runMode !== "existing_session" &&
    form.executionTarget === "machine" &&
    form.machineSandboxId
      ? {
          machineTarget: {
            targetSandboxId: form.machineSandboxId,
            ...(form.workingDir.trim() ? { workingDir: form.workingDir.trim() } : {}),
          },
        }
      : form.runMode !== "existing_session" && form.sandboxBackend
        ? { sandboxBackend: form.sandboxBackend }
        : {}),
  };
}

// Compared against the deduplicated selection rendered in CALENDAR_DAY_ORDER,
// so both keys are written in that same Sunday-first order.
const WEEKDAY_SELECTION = "MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY";
const WEEKEND_SELECTION = "SUNDAY,SATURDAY";

/**
 * Cadence half of a calendar label. A calendar schedule with `daysOfWeek` is a
 * weekly schedule, not a daily one - claiming "Daily" for a Monday-only rule
 * was the label lying about when the task fires.
 *
 * Unknown or duplicated entries are dropped rather than rendered: this list is
 * displayed straight from a list read, and an empty selection means the
 * schedule fires every day, which is exactly what Temporal does with no
 * `dayOfWeek` filter.
 */
function calendarDaysLabel(days: readonly ScheduledTaskCalendarDay[] | undefined): string {
  const selected = normalizeCalendarDays(days);
  if (selected.length === 0 || selected.length === CALENDAR_DAY_ORDER.length) {
    return "Daily";
  }
  const key = selected.join(",");
  if (key === WEEKDAY_SELECTION) return "Weekdays";
  if (key === WEEKEND_SELECTION) return "Weekends";
  return selected.map((day) => CALENDAR_DAY_LABEL[day]).join(", ");
}

export function scheduleLabel(schedule: ScheduledTaskScheduleSpec): string {
  if (schedule.type === "manual") return "On demand";
  if (schedule.type === "interval") {
    const minutes = Math.round(schedule.everySeconds / 60);
    if (minutes % (24 * 60) === 0) {
      const days = minutes / (24 * 60);
      return `Every ${days} ${days === 1 ? "day" : "days"}`;
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return `Every ${hours} ${hours === 1 ? "hour" : "hours"}`;
    }
    return `Every ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (schedule.type === "calendar") {
    const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
    return `${calendarDaysLabel(schedule.daysOfWeek)} ${time} ${schedule.timeZone}`;
  }
  // A `once` label deliberately omits `schedule.timeZone`. The API materializes
  // this variant by reading UTC calendar fields off the absolute instant and
  // pinning the Temporal spec to UTC (`temporalScheduleSpec`), so the spec's own
  // timeZone is never honored. Naming it here would promise a wall clock the
  // schedule does not keep; the absolute instant rendered in the viewer's local
  // zone is true regardless of which zone was stored.
  return `Once ${formatTimestamp(schedule.runAt)}`;
}

const CALENDAR_SCAN_MINUTES = 8 * 24 * 60;
const CALENDAR_WEEKDAY: Record<string, ScheduledTaskCalendarDay> = {
  Sun: "SUNDAY",
  Mon: "MONDAY",
  Tue: "TUESDAY",
  Wed: "WEDNESDAY",
  Thu: "THURSDAY",
  Fri: "FRIDAY",
  Sat: "SATURDAY",
};

/** Exact next boundary for the interval and calendar semantics sent to Temporal. */
export function nextScheduledRunAt(
  schedule: ScheduledTaskScheduleSpec,
  now: Date = new Date(),
): Date | null {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || schedule.type === "manual") return null;
  if (schedule.type === "once") {
    const runAt = new Date(schedule.runAt);
    return Number.isFinite(runAt.getTime()) && runAt.getTime() > nowMs ? runAt : null;
  }
  if (schedule.type === "interval") {
    const everyMs = schedule.everySeconds * 1_000;
    if (!Number.isSafeInteger(everyMs) || everyMs <= 0) return null;
    const startMs = schedule.startAt
      ? new Date(schedule.startAt).getTime()
      : Number.NEGATIVE_INFINITY;
    if (Number.isNaN(startMs)) return null;
    const phase = Number.isFinite(startMs) ? ((startMs % everyMs) + everyMs) % everyMs : 0;
    const lowerBound = Math.max(nowMs + 1, startMs);
    const candidateMs = phase + Math.ceil((lowerBound - phase) / everyMs) * everyMs;
    const endMs = schedule.endAt ? new Date(schedule.endAt).getTime() : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(candidateMs) || Number.isNaN(endMs) || candidateMs > endMs) {
      return null;
    }
    return new Date(candidateMs);
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: schedule.timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
  const selectedDays = normalizeCalendarDays(schedule.daysOfWeek);
  const firstMinute = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset < CALENDAR_SCAN_MINUTES; offset += 1) {
    const candidate = new Date(firstMinute + offset * 60_000);
    const parts = Object.fromEntries(
      formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
    );
    const weekday = CALENDAR_WEEKDAY[parts.weekday ?? ""];
    if (
      Number(parts.hour) === schedule.hour &&
      Number(parts.minute) === schedule.minute &&
      weekday &&
      (selectedDays.length === 0 || selectedDays.includes(weekday))
    ) {
      return candidate;
    }
  }
  return null;
}

export function nextScheduledRunLabel(
  schedule: ScheduledTaskScheduleSpec,
  now: Date = new Date(),
): string | null {
  const next = nextScheduledRunAt(schedule, now);
  if (!next) return null;
  const minutes = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `Next in ${minutes}m`;
  if (minutes < 24 * 60) return `Next in ${Math.round(minutes / 60)}h`;
  return `Next in ${Math.round(minutes / (24 * 60))}d`;
}

export type LastRunSummary = {
  run: ScheduledTaskRun;
  /** Honest one-line status for the task list row. */
  label: string;
  tone: "ok" | "failed" | "pending";
};

/** Most recent run (by firedAt) summarized for the task list. */
export function summarizeLastRun(runs: ScheduledTaskRun[]): LastRunSummary | null {
  const last = [...runs].sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0];
  if (!last) {
    return null;
  }
  if (last.status === "failed") {
    return {
      run: last,
      label: `last run failed${last.error ? `: ${last.error}` : ""}`,
      tone: "failed",
    };
  }
  if (last.status === "succeeded") {
    const summary = last.knowledgeSummary;
    return {
      run: last,
      label: summary
        ? `last sync imported ${summary.imported}, unchanged ${summary.unchanged}, failed ${summary.failed}`
        : `last run succeeded ${formatTimestamp(last.completedAt ?? last.firedAt)}`,
      tone: "ok",
    };
  }
  if (last.status === "skipped") {
    return {
      run: last,
      label: "last run skipped due to overlap",
      tone: "pending",
    };
  }
  if (last.status === "dispatched") {
    return {
      run: last,
      label: `last run ${formatTimestamp(last.firedAt)}`,
      tone: "ok",
    };
  }
  return {
    run: last,
    label: `run queued ${formatTimestamp(last.firedAt)}`,
    tone: "pending",
  };
}

/** Collapsed cards stay quiet after success; only actionable/in-flight outcomes surface. */
export function notableLastRunSummary(runs: ScheduledTaskRun[]): LastRunSummary | null {
  const summary = summarizeLastRun(runs);
  return summary?.run.status === "succeeded" ? null : summary;
}

export type ScheduledTaskGroups = {
  /** Schedules that will actually fire, most recently run first. */
  active: ScheduledTask[];
  /** User-paused, connection-paused, and source-disabled schedules. */
  paused: ScheduledTask[];
};

/**
 * Millisecond value for an ordering key. A missing, unknown, or unparseable
 * timestamp sorts last rather than throwing off the comparator, which keeps one
 * malformed row from reshuffling the whole list.
 */
function orderingInstant(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

// Descending, and written as explicit comparisons rather than a subtraction
// because two "never ran" tasks would subtract -Infinity from -Infinity and
// hand the sort a NaN.
function descending(a: number, b: number): number {
  if (a === b) return 0;
  return b > a ? 1 : -1;
}

/**
 * Split the list into the two sections the page renders, each ordered by most
 * recent run and then by creation, both descending. A task nobody has run yet
 * sorts after every task that has run.
 *
 * The membership test is `scheduledTaskStateLabel().active`, not
 * `status === "paused"`: a connector schedule whose source was disabled or whose
 * connection is paused will not fire either, so promoting it into the live list
 * would claim activity that is not happening. Each card still renders its own
 * exact reason chip.
 *
 * Ordering keys are supplied by the caller because the wire `ScheduledTask`
 * carries no last-run fact. Ties preserve server order: `Array#sort` is stable.
 */
export function groupScheduledTasksForList(
  tasks: readonly ScheduledTask[],
  lastRunAtByTaskId: Readonly<Record<string, string | null | undefined>>,
): ScheduledTaskGroups {
  const compare = (a: ScheduledTask, b: ScheduledTask): number => {
    const byRun = descending(
      orderingInstant(lastRunAtByTaskId[a.id]),
      orderingInstant(lastRunAtByTaskId[b.id]),
    );
    return byRun !== 0
      ? byRun
      : descending(orderingInstant(a.createdAt), orderingInstant(b.createdAt));
  };
  const active: ScheduledTask[] = [];
  const paused: ScheduledTask[] = [];
  for (const task of tasks) {
    (scheduledTaskStateLabel(task).active ? active : paused).push(task);
  }
  return { active: active.sort(compare), paused: paused.sort(compare) };
}

const RUN_STATUS_LABEL: Record<ScheduledTaskRun["status"], string> = {
  queued: "Queued",
  dispatched: "Started",
  succeeded: "Succeeded",
  skipped: "Skipped",
  failed: "Failed",
};

const RUN_TRIGGER_LABEL: Record<ScheduledTaskRun["triggerType"], string> = {
  scheduled: "Scheduled",
  manual: "Run now",
  initial: "First run",
  provider_event: "Provider event",
  retry: "Retry",
  repair: "Repair",
};

/** Sentence-case outcome for a run row; falls back to the raw wire value. */
function scheduledTaskRunStatusLabel(status: ScheduledTaskRun["status"]): string {
  return RUN_STATUS_LABEL[status] ?? status;
}

/** Sentence-case cause for a run row; falls back to the raw wire value. */
export function scheduledTaskRunTriggerLabel(triggerType: ScheduledTaskRun["triggerType"]): string {
  return RUN_TRIGGER_LABEL[triggerType] ?? triggerType;
}

/** Current and legacy persisted values that add no information on this page. */
export function scheduledTaskRunTriggerIsRedundant(triggerType: unknown): boolean {
  return triggerType === "scheduled" || triggerType === "schedule";
}

/**
 * Human identity for one run. A run id names nothing a person can act on, and
 * two runs of the same task are told apart by when they fired and how they
 * ended - so that pair, not the uuid, is the row's label.
 */
export function scheduledTaskRunLabel(run: ScheduledTaskRun): string {
  return `${scheduledTaskRunStatusLabel(run.status)} · ${formatTimestamp(run.firedAt)}`;
}

export type ScheduledTaskRunSessionAccess =
  /** The run produced a session this viewer may open. */
  | "open"
  /** The run produced a session, but this viewer may not open it. */
  | "restricted"
  /** No session exists to link to. */
  | "none";

/**
 * Whether a run row can offer a session link.
 *
 * `run.sessionId` is nulled by `scheduledTaskRunForGrant` for any viewer without
 * `sessions:control`, so a null id is ambiguous on its own. An agent run that
 * reached dispatch definitely produced a session; when the viewer cannot see the
 * id, saying "you cannot open it" is the honest reading. A dead link or a
 * silently dropped row would both misdescribe what happened.
 *
 * `canReadSessionIds` is exactly that `sessions:control` grant - the thing that
 * decides whether the id was stripped - and not the wider pair the page needs
 * before it can actually navigate.
 */
export function scheduledTaskRunSessionAccess(
  run: ScheduledTaskRun,
  options: { canReadSessionIds: boolean },
): ScheduledTaskRunSessionAccess {
  if (run.sessionId) return "open";
  // With the id readable, a null genuinely means no session was created (a
  // connector sync, or a run that never reached dispatch).
  if (options.canReadSessionIds) return "none";
  if (run.actionKind !== "agent_turn") return "none";
  return run.status === "dispatched" || run.status === "succeeded" ? "restricted" : "none";
}

type KnowledgeSyncAction = Extract<ScheduledTask["action"], { kind: "knowledge_source_sync" }>;

const KNOWLEDGE_SCOPE_LABEL: Record<string, string> = {
  organization: "Organization scope",
  workspace: "Workspace scope",
  personal: "Personal scope",
};

/**
 * Human descriptor for a connector-sync card, replacing the truncated source
 * uuid this line used to print. Eight hex characters named nothing a person
 * could look up; the destination scope and provider domain are what actually
 * distinguish two syncs.
 *
 * Both reads are defensive. The wire type promises `destination` and
 * `connection`, but this renders straight from a list read, and one legacy or
 * partially written action must degrade to a single vague card rather than
 * throwing the whole page into the error boundary.
 */
export function knowledgeSyncSourceLabel(action: KnowledgeSyncAction): string {
  const destinationKind = (action.destination as { kind?: string } | undefined)?.kind;
  const scope =
    (destinationKind ? KNOWLEDGE_SCOPE_LABEL[destinationKind] : undefined) ?? "Unknown scope";
  const provider = (action.connection as { providerDomain?: string } | undefined)?.providerDomain;
  const reach = action.allDescendants ? "with descendants" : "selected only";
  return [scope, provider, reach].filter((part) => Boolean(part)).join(" · ");
}
