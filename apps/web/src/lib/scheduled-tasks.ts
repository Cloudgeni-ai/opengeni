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
  overlapPolicy: ScheduledTask["overlapPolicy"];
  targetSessionId: string | null;
  includeOpenGeniTool: boolean;
  resources: ResourceRef[];
};

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
    overlapPolicy: "allow_concurrent",
    targetSessionId: null,
    includeOpenGeniTool,
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
  } else {
    base.scheduleType = "once";
    base.runAt = localDateTimeValue(new Date(schedule.runAt));
    base.timeZone = schedule.timeZone ?? base.timeZone;
  }
  return {
    ...base,
    name: task.name,
    prompt: task.agentConfig.prompt,
    runMode: task.runMode,
    overlapPolicy: task.overlapPolicy,
    targetSessionId: task.targetSessionId,
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
    ...((existingTask?.agentConfig.model ?? defaults.model)
      ? { model: existingTask?.agentConfig.model ?? defaults.model }
      : {}),
    ...((existingTask?.agentConfig.reasoningEffort ?? defaults.reasoningEffort)
      ? { reasoningEffort: existingTask?.agentConfig.reasoningEffort ?? defaults.reasoningEffort }
      : {}),
    ...(existingTask?.agentConfig.sandboxBackend
      ? { sandboxBackend: existingTask.agentConfig.sandboxBackend }
      : {}),
    // The form has no goal editor, but unrelated edits must not silently
    // erase hidden task configuration. Targeted tasks with a goal are rejected
    // by the contract/domain policy; preserving it here keeps old data honest
    // and lets the API return that explicit correction instead of clearing it.
    ...(existingTask?.agentConfig.goal ? { goal: existingTask.agentConfig.goal } : {}),
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
  if (last.status === "dispatched") {
    return { run: last, label: `last run ${formatTimestamp(last.firedAt)}`, tone: "ok" };
  }
  return { run: last, label: `run queued ${formatTimestamp(last.firedAt)}`, tone: "pending" };
}
