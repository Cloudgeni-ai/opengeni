/**
 * Pure helpers for the Schedules pages: the cadence in words, the next run,
 * the list order, the derived name, and the create/update requests built from
 * the form draft. The cadence words and next runs come from the shared
 * CadencePicker logic, so the list, the schedule page and the form agree.
 */
import {
  DEFAULT_CADENCE_TIME,
  cadenceFromScheduleSpec,
  describeCadence,
  formatRunTime,
  nextRuns,
  toScheduleSpec,
  validateCadence,
  type CadenceFrequency,
  type CadenceScheduleSpec,
  type CadenceValue,
} from "@/components/ui/cadence-picker";
import {
  agentConfigFromFormState,
  newScheduledTaskFormState,
  scheduledTaskStateLabel,
  taskMetadataFromFormState,
  type ScheduledTaskFormState,
} from "@/lib/scheduled-tasks";
import type { CreateScheduledTaskRequest, UpdateScheduledTaskRequest } from "@opengeni/sdk";
import type { ScheduledTask, ScheduledTaskRun, ScheduledTaskScheduleSpec } from "@/types";

type CreateAgentScheduledTaskRequest = Extract<
  CreateScheduledTaskRequest,
  { agentConfig: unknown }
>;

/** Agent learning overrides sent with an edit (not in the SDK's update type yet). */
export interface ScheduleLearningUpdate {
  scope: "personal" | "workspace";
  baselineScope?: "personal" | "workspace";
  operationId: string;
  expectedVersion: number;
  settings: NonNullable<ScheduledTaskFormState["agentLearning"]>;
}

/**
 * The frequencies a schedule can store. No "Every month on day N": the API's
 * calendar spec has no day of month yet, so offering it would save a rule the
 * server can't keep.
 */
export const SCHEDULE_FREQUENCIES: readonly CadenceFrequency[] = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "interval",
  "once",
];

export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "Every weekday at 09:00, your time": the default for a new schedule. */
export function defaultCadence(timeZone: string = viewerTimeZone()): CadenceValue {
  return { timeZone, rule: { frequency: "weekdays", time: DEFAULT_CADENCE_TIME } };
}

/** The stored spec as an editable cadence, or null for on-demand schedules. */
export function cadenceOfSchedule(
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

export function specFromCadence(value: CadenceValue, now: Date): ScheduledTaskScheduleSpec {
  return toScheduleSpec(value.rule, {
    timeZone: value.timeZone,
    now,
  }) as unknown as ScheduledTaskScheduleSpec;
}

export interface ScheduleWords {
  /** "Every weekday at 08:00 · Oslo", for rows and meta lines. */
  short: string;
  /** "Runs every weekday at 08:00 Oslo time", for sentences. */
  sentence: string;
}

export function scheduleWords(schedule: ScheduledTaskScheduleSpec, now: Date): ScheduleWords {
  const cadence = cadenceOfSchedule(schedule);
  if (!cadence) {
    return { short: "Only when you run it", sentence: "Runs only when someone presses Run now" };
  }
  return cadenceWords(cadence, now);
}

export function cadenceWords(cadence: CadenceValue, now: Date): ScheduleWords {
  const words = describeCadence(cadence.rule, { timeZone: cadence.timeZone, now });
  return { short: words.short, sentence: words.sentence };
}

/** The next run, or null when paused, on demand, or no runs are left. */
export function nextRunOf(task: ScheduledTask, now: Date): Date | null {
  if (!scheduledTaskStateLabel(task).active) return null;
  const cadence = cadenceOfSchedule(task.schedule);
  if (!cadence) return null;
  return nextRuns(cadence.rule, { timeZone: cadence.timeZone, now, count: 1 })[0] ?? null;
}

/** "Mon 28 Sep, 08:00" or "Today, 14:00" in the viewer's zone. */
export function runTimeLabel(date: Date, now: Date): string {
  return formatRunTime(date, { timeZone: viewerTimeZone(), now });
}

export function cadenceIssue(cadence: CadenceValue | null, now: Date): string | null {
  if (!cadence) return null;
  return validateCadence(cadence.rule, { timeZone: cadence.timeZone, now })?.message ?? null;
}

/**
 * Active schedules by next run (soonest first), then everything that won't
 * fire (paused, sync off, on demand, no runs left) by name.
 */
export function sortSchedulesForList(tasks: readonly ScheduledTask[], now: Date): ScheduledTask[] {
  const keyed = tasks.map((task) => ({ task, next: nextRunOf(task, now)?.getTime() ?? null }));
  keyed.sort((left, right) => {
    const leftLive = left.next !== null;
    const rightLive = right.next !== null;
    if (leftLive !== rightLive) return leftLive ? -1 : 1;
    if (leftLive && rightLive && left.next !== right.next) return left.next! - right.next!;
    return left.task.name.localeCompare(right.task.name);
  });
  return keyed.map((entry) => entry.task);
}

export type LastRunState =
  | { kind: "unknown" }
  | { kind: "never" }
  | { kind: "run"; run: ScheduledTaskRun };

export function lastRunState(
  lastRuns: Readonly<Record<string, ScheduledTaskRun | null>>,
  taskId: string,
): LastRunState {
  if (!(taskId in lastRuns)) return { kind: "unknown" };
  const run = lastRuns[taskId];
  return run ? { kind: "run", run } : { kind: "never" };
}

/** Knowledge source syncs keep their own small editor and wording. */
export function isKnowledgeSync(task: ScheduledTask): boolean {
  return task.action?.kind === "knowledge_source_sync";
}

export function ownsSchedule(task: ScheduledTask, viewerSubjectId: string): boolean {
  return task.ownerSubjectId === null || task.ownerSubjectId === viewerSubjectId;
}

/** The owner's display name from the task's frozen creator snapshot. */
export function ownerName(task: ScheduledTask): string {
  const created = task.createdBy;
  if (created && created.subjectId === task.ownerSubjectId && created.label?.trim()) {
    return created.label.trim();
  }
  const subject = task.ownerSubjectId ?? "";
  const bare = subject.includes(":") ? subject.slice(subject.indexOf(":") + 1) : subject;
  return bare.trim() || "Someone else";
}

/* ----------------------------------------------------------------------------
   Names.
   -------------------------------------------------------------------------- */

const DANGLING_WORD = /\s+(a|an|and|at|by|for|from|in|into|of|on|or|the|to|with)$/i;
const NAME_LIMIT = 60;

/**
 * The name a schedule gets when Name is left empty: the first sentence of the
 * instructions, without a leading "Every weekday at 08:00:" and at most 60
 * characters, ending on a word that carries meaning.
 */
export function deriveScheduleName(instructions: string): string {
  const withoutCadence = instructions.trim().replace(/^every\b.{0,40}?:\s+/i, "");
  const firstSentence = withoutCadence.split(/(?<=[.!?])\s|\n/)[0]?.replace(/[.!?]$/, "") ?? "";
  const clean = firstSentence.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const capitalized = clean.charAt(0).toLocaleUpperCase() + clean.slice(1);
  if (capitalized.length <= NAME_LIMIT) return capitalized;
  let cut = capitalized.slice(0, NAME_LIMIT);
  const space = cut.lastIndexOf(" ");
  if (space > 20) cut = cut.slice(0, space);
  cut = cut.replace(/[,;:]$/, "");
  while (DANGLING_WORD.test(cut)) cut = cut.replace(DANGLING_WORD, "");
  return `${cut}…`;
}

export const NAME_MAX_LENGTH = 80;

/* ----------------------------------------------------------------------------
   The form draft.
   -------------------------------------------------------------------------- */

/**
 * Everything the form edits: the stored-task form state (model, run mode,
 * compute, tools, learning) plus the cadence and the attachments the old
 * editor never showed.
 */
export interface ScheduleDraft extends ScheduledTaskFormState {
  /** Null for a schedule that only runs with Run now. */
  cadence: CadenceValue | null;
  variableSetId: string | null;
  rigId: string | null;
}

export interface DraftDefaults {
  includeOpenGeniTool: boolean;
  model?: string;
  reasoningEffort?: ScheduledTaskFormState["reasoningEffort"];
  modelFollowsDefault?: boolean;
  defaultSandboxBackend?: ScheduledTaskFormState["sandboxBackend"] | undefined;
  defaultMachineSandboxId?: string;
}

function formDefaults(defaults: DraftDefaults) {
  return {
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    modelFollowsDefault: defaults.modelFollowsDefault,
    defaultSandboxBackend: defaults.defaultSandboxBackend || undefined,
    defaultMachineSandboxId: defaults.defaultMachineSandboxId,
  };
}

export function newScheduleDraft(defaults: DraftDefaults, timeZone?: string): ScheduleDraft {
  return {
    ...newScheduledTaskFormState(defaults.includeOpenGeniTool, [], formDefaults(defaults)),
    cadence: defaultCadence(timeZone),
    variableSetId: null,
    rigId: null,
  };
}

export interface ScheduleTemplate {
  id: string;
  name: string;
  description: string;
  instructions: string;
  cadence: CadenceValue["rule"];
}

export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  {
    id: "morning-brief",
    name: "Morning brief",
    description: "What changed in your repositories and any open incidents.",
    instructions:
      "Summarize what changed in our repositories since yesterday and list any open incidents. Keep it short and link to the details.",
    cadence: { frequency: "weekdays", time: "08:00" },
  },
  {
    id: "dependency-pr",
    name: "Weekly dependency update",
    description: "Bump outdated dependencies and open one pull request.",
    instructions:
      "Check the repository for outdated dependencies, update the safe ones, run the tests, and open one pull request that explains each change.",
    cadence: { frequency: "weekly", days: ["mon"], time: "09:30" },
  },
  {
    id: "cost-check",
    name: "Daily cost check",
    description: "Flag unusual cloud spend from the last day.",
    instructions:
      "Summarize yesterday's cloud spend by service and flag anything that is more than 20% above the weekly average.",
    cadence: { frequency: "weekdays", time: "08:00" },
  },
];

export function templateById(id: string | undefined): ScheduleTemplate | undefined {
  return SCHEDULE_TEMPLATES.find((template) => template.id === id);
}

export function draftFromTemplate(
  template: ScheduleTemplate,
  defaults: DraftDefaults,
  timeZone?: string,
): ScheduleDraft {
  const base = newScheduleDraft(defaults, timeZone);
  return {
    ...base,
    name: template.name,
    prompt: template.instructions,
    cadence: { timeZone: base.cadence!.timeZone, rule: template.cadence },
  };
}

/** "Every weekday at 08:00: …" templates show their cadence as a tile meta. */
export function templateCadenceLabel(template: ScheduleTemplate, now: Date): string {
  return describeCadence(template.cadence, { timeZone: viewerTimeZone(), now }).short.replace(
    / · .*$/,
    "",
  );
}

/* ----------------------------------------------------------------------------
   Requests.
   -------------------------------------------------------------------------- */

export function scheduleName(draft: Pick<ScheduleDraft, "name" | "prompt">): string {
  return draft.name.trim() || deriveScheduleName(draft.prompt) || "Untitled schedule";
}

/**
 * Only "one ongoing chat" and "an existing chat" can overlap a running turn,
 * so a new-chat schedule is always created with the default overlap policy.
 */
export function overlapPolicyForCreate(
  draft: Pick<ScheduleDraft, "runMode" | "overlapPolicy">,
): ScheduleDraft["overlapPolicy"] {
  return draft.runMode === "new_session_per_run" ? "allow_concurrent" : draft.overlapPolicy;
}

export function createRequestFromDraft(
  draft: ScheduleDraft,
  options: {
    now: Date;
    learningScope: "personal" | "workspace";
  },
): CreateAgentScheduledTaskRequest {
  const schedule: ScheduledTaskScheduleSpec = draft.cadence
    ? specFromCadence(draft.cadence, options.now)
    : { type: "manual" };
  return {
    ...(draft.agentLearning && Object.keys(draft.agentLearning).length
      ? { agentLearning: { scope: options.learningScope, settings: draft.agentLearning } }
      : {}),
    name: scheduleName(draft),
    schedule,
    runMode: draft.runMode,
    ...(draft.runMode === "existing_session" ? { targetSessionId: draft.targetSessionId } : {}),
    overlapPolicy: overlapPolicyForCreate(draft),
    metadata: taskMetadataFromFormState(draft),
    connectionAccounts: draft.connectionAccounts ?? [],
    agentConfig: agentConfigFromFormState(draft),
    ...(draft.variableSetId ? { variableSetId: draft.variableSetId } : {}),
    ...(draft.rigId ? { rigId: draft.rigId } : {}),
  };
}

function sameCadence(left: CadenceValue | null, right: CadenceValue | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The PATCH for an edited schedule. The schedule spec, variable set and
 * Sandbox Environment are sent only when they changed, so an untouched field
 * the editor can't fully express (an interval end, a set this viewer can't
 * list) is never rewritten.
 */
export function updateRequestFromDraft(
  task: ScheduledTask,
  initial: ScheduleDraft,
  draft: ScheduleDraft,
  options: {
    now: Date;
    agentLearning?: ScheduleLearningUpdate;
  },
): UpdateScheduledTaskRequest & { agentLearning?: ScheduleLearningUpdate } {
  return {
    ...(options.agentLearning ? { agentLearning: options.agentLearning } : {}),
    name: scheduleName(draft),
    ...(sameCadence(initial.cadence, draft.cadence)
      ? {}
      : {
          schedule: draft.cadence
            ? specFromCadence(draft.cadence, options.now)
            : ({ type: "manual" } as const),
        }),
    runMode: draft.runMode,
    targetSessionId: draft.runMode === "existing_session" ? draft.targetSessionId : null,
    overlapPolicy: draft.overlapPolicy,
    metadata: taskMetadataFromFormState(draft, task),
    connectionAccounts: draft.connectionAccounts ?? [],
    agentConfig: agentConfigFromFormState(draft, task),
    ...(initial.variableSetId === draft.variableSetId
      ? {}
      : { variableSetId: draft.variableSetId }),
    ...(initial.rigId === draft.rigId ? {} : { rigId: draft.rigId }),
  };
}

/* ----------------------------------------------------------------------------
   Errors.
   -------------------------------------------------------------------------- */

/**
 * What the server said, in a sentence, without the "OpenGeni API 422:" prefix
 * or the request reference (that belongs in Technical details).
 */
export function scheduleErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const clean = raw
    .replace(/\s*Reference:\s*[\w-]+\.?\s*$/i, "")
    .replace(/^OpenGeni API \d+:\s*/i, "")
    .replace(/^API\s+\d+:\s*/i, "")
    .trim();
  if (!clean) return "Something went wrong. Try again.";
  const sentence = clean.charAt(0).toLocaleUpperCase() + clean.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** The request reference of an API error, for Technical details. */
export function scheduleErrorReference(error: unknown): string | undefined {
  const reference = (error as { correlationId?: unknown } | null)?.correlationId;
  return typeof reference === "string" ? reference : undefined;
}

/* ----------------------------------------------------------------------------
   Create with OpenGeni.
   -------------------------------------------------------------------------- */

/**
 * The first message of a "Create with OpenGeni" chat. The person says what
 * should happen and how often. Setup guidance belongs in the bundled
 * opengeni-schedules Skill, which the agent reads when this request is relevant.
 */
export function scheduleAgentOpeningMessage(request: string, timeZone: string): string {
  return [
    "Help me create a schedule in this workspace.",
    "",
    request.trim(),
    "",
    `My time zone is ${timeZone}.`,
  ].join("\n");
}
