import { localDateTimeValue, formatTimestamp } from "@/lib/format";
import type {
  ReasoningEffort,
  ResourceRef,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  ScheduledTaskRun,
  ScheduledTaskScheduleSpec,
} from "@/types";

export type ScheduledTaskFormState = {
  name: string;
  prompt: string;
  scheduleType: "once" | "interval" | "calendar";
  runAt: string;
  intervalMinutes: number;
  calendarTime: string;
  timeZone: string;
  runMode: ScheduledTask["runMode"];
  targetSessionId: string;
  overlapPolicy: ScheduledTask["overlapPolicy"];
  includeOpenGeniTool: boolean;
  slackBotConnectionId: string;
  resources: ResourceRef[];
};

export function scheduledTaskStateLabel(task: ScheduledTask): {
  label: string;
  active: boolean;
  reason: "active" | "user_paused" | "connection_paused" | "source_disabled";
} {
  if (task.status === "paused") {
    return { label: "Paused", active: false, reason: "user_paused" };
  }
  if (task.action.kind === "knowledge_source_sync") {
    const value = task.metadata.knowledgeSourceSync;
    if (value && typeof value === "object") {
      const control = value as Record<string, unknown>;
      if (control.sourceEnabled === false) {
        return { label: "Sync disabled", active: false, reason: "source_disabled" };
      }
      if (control.connectionPaused === true) {
        return { label: "Connection paused", active: false, reason: "connection_paused" };
      }
    }
  }
  return { label: "Active", active: true, reason: "active" };
}

export function newScheduledTaskFormState(
  includeOpenGeniTool: boolean,
  resources: ResourceRef[] = [],
): ScheduledTaskFormState {
  return {
    name: "",
    prompt: "",
    scheduleType: "once",
    runAt: localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000)),
    intervalMinutes: 60,
    calendarTime: "09:00",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    runMode: "new_session_per_run",
    targetSessionId: "",
    overlapPolicy: "allow_concurrent",
    includeOpenGeniTool,
    slackBotConnectionId: "",
    resources,
  };
}

export function formStateFromScheduledTask(task: ScheduledTask): ScheduledTaskFormState {
  const schedule = task.schedule;
  const base = newScheduledTaskFormState(
    task.agentConfig.tools.some((tool) => tool.kind === "mcp" && tool.id === "opengeni"),
    task.agentConfig.resources,
  );
  if (schedule.type === "interval") {
    base.scheduleType = "interval";
    base.intervalMinutes = Math.max(1, Math.round(schedule.everySeconds / 60));
  } else if (schedule.type === "calendar") {
    base.scheduleType = "calendar";
    base.calendarTime = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
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
    prompt: task.agentConfig.prompt,
    runMode: task.runMode,
    targetSessionId: task.targetSessionId ?? "",
    overlapPolicy: task.overlapPolicy,
    slackBotConnectionId: task.agentConfig.slackBotConnectionId ?? "",
  };
}

export function scheduleFromFormState(form: ScheduledTaskFormState): ScheduledTaskScheduleSpec {
  return scheduledTaskSchedule(
    form.scheduleType,
    form.runAt,
    form.intervalMinutes,
    form.calendarTime,
    form.timeZone,
  );
}

export function agentConfigFromFormState(
  form: ScheduledTaskFormState,
  existingTask?: ScheduledTask,
  defaults: { resources?: ResourceRef[]; model?: string; reasoningEffort?: ReasoningEffort } = {},
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
    ...((existingTask?.agentConfig.model ?? defaults.model)
      ? { model: existingTask?.agentConfig.model ?? defaults.model }
      : {}),
    ...((existingTask?.agentConfig.reasoningEffort ?? defaults.reasoningEffort)
      ? { reasoningEffort: existingTask?.agentConfig.reasoningEffort ?? defaults.reasoningEffort }
      : {}),
    ...(existingTask?.agentConfig.sandboxBackend
      ? { sandboxBackend: existingTask.agentConfig.sandboxBackend }
      : {}),
  };
}

function scheduledTaskSchedule(
  type: "once" | "interval" | "calendar",
  runAt: string,
  intervalMinutes: number,
  calendarTime: string,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): ScheduledTaskScheduleSpec {
  if (type === "interval") {
    return { type: "interval", everySeconds: Math.max(60, Math.round(intervalMinutes * 60)) };
  }
  if (type === "calendar") {
    const [hourRaw, minuteRaw] = calendarTime.split(":");
    return {
      type: "calendar",
      timeZone,
      hour: Number(hourRaw ?? 9),
      minute: Number(minuteRaw ?? 0),
    };
  }
  return {
    type: "once",
    runAt: new Date(runAt).toISOString(),
    timeZone,
  };
}

export function scheduleLabel(schedule: ScheduledTaskScheduleSpec): string {
  if (schedule.type === "manual") return "On demand";
  if (schedule.type === "interval") {
    return `Every ${Math.round(schedule.everySeconds / 60)} min`;
  }
  if (schedule.type === "calendar") {
    return `Daily ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")} ${schedule.timeZone}`;
  }
  return `Once ${formatTimestamp(schedule.runAt)}`;
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
    return { run: last, label: "last run skipped due to overlap", tone: "pending" };
  }
  if (last.status === "dispatched") {
    return { run: last, label: `last run ${formatTimestamp(last.firedAt)}`, tone: "ok" };
  }
  return { run: last, label: `run queued ${formatTimestamp(last.firedAt)}`, tone: "pending" };
}
