/**
 * Kit-only data for the Schedules page previews: the fixture schedules as
 * editable items, the form draft, labels and permissions. Pure functions; the
 * cadence words and next runs come from the real CadencePicker logic so the
 * list, the sheet and the form always agree.
 */
import {
  DEFAULT_CADENCE_TIME,
  describeCadence,
  describeNextRuns,
  formatRunTime,
  nextRuns,
  normalizeCadenceRule,
  type CadenceValue,
} from "@/components/ui/cadence-picker";

import {
  KIT_NOW,
  KIT_TIME_ZONE,
  learningModes,
  modelCatalog,
  personById,
  repositories,
  sandboxEnvironments,
  scheduleTemplates,
  schedules,
  timeZones,
  variableSets,
  you,
  type LearningMode,
  type Schedule,
  type ScheduleRun,
} from "../../fixtures";

/* ----------------------------------------------------------------------------
   Pending product questions this preview can show both ways.
   -------------------------------------------------------------------------- */

export interface SchedulesQuestions {
  /** Q22: remove the Description field (recommended) or keep it. */
  q22RemoveDescription: boolean;
  /** Q23: default to every weekday 09:00 with monthly (recommended), or one time in an hour. */
  q23WeekdayDefault: boolean;
  /** Q24: attach repositories, a variable set and an environment in the form. */
  q24Attachments: boolean;
  /** Q25: paused schedules stay in one list (recommended), or in a collapsed section. */
  q25OneList: boolean;
  /** Q26: workspace admins can pause and delete someone else's schedule. */
  q26AdminsManage: boolean;
  /** Q27: "If the previous run is still working" only for one ongoing chat. */
  q27OngoingOnly: boolean;
}

export const RECOMMENDED_QUESTIONS: SchedulesQuestions = {
  q22RemoveDescription: true,
  q23WeekdayDefault: true,
  q24Attachments: true,
  q25OneList: true,
  q26AdminsManage: true,
  q27OngoingOnly: true,
};

/* ----------------------------------------------------------------------------
   Items.
   -------------------------------------------------------------------------- */

export type EachRun = "new_chat" | "ongoing_chat";
export type IfStillRunning = "queue" | "skip";
export type WhereItRuns = "managed" | "machine";
export type LearningChoice = "default" | LearningMode;

export interface LearningDraft {
  knowledge: LearningChoice;
  instructions: LearningChoice;
  skills: LearningChoice;
}

/** Everything the form edits. */
export interface ScheduleDraft {
  instructions: string;
  /** "default" follows the workspace default at each run. */
  modelId: string;
  repository: string;
  variableSetId: string;
  environmentId: string;
  tools: string[];
  cadence: CadenceValue;
  name: string;
  description: string;
  eachRun: EachRun;
  ifStillRunning: IfStillRunning;
  whereItRuns: WhereItRuns;
  learning: LearningDraft;
}

export type LastRunStatus = "succeeded" | "failed" | "running" | "never";

export interface ScheduleItem extends ScheduleDraft {
  id: string;
  state: "active" | "paused";
  ownerId: string;
  lastRun: { status: LastRunStatus; at?: string };
  runs: ScheduleRun[];
}

export const NONE = "none";
export const DEFAULT_MODEL = "default";

const DEFAULT_LEARNING: LearningDraft = {
  knowledge: "default",
  instructions: "default",
  skills: "default",
};

/** Tools a schedule can use, from the workspace's connections. */
export interface ToolOption {
  id: string;
  name: string;
  /** Why it can't be added right now. */
  unavailableReason?: string;
}

export const TOOL_OPTIONS: ToolOption[] = [
  { id: "slack", name: "Slack" },
  { id: "sentry", name: "Sentry" },
  { id: "github", name: "GitHub" },
  { id: "datadog", name: "Datadog" },
  { id: "linear", name: "Linear", unavailableReason: "Sign in again to use Linear." },
];

export function toolById(id: string): ToolOption | undefined {
  return TOOL_OPTIONS.find((tool) => tool.id === id);
}

function toolIds(names: string[]): string[] {
  return names
    .map((name) => TOOL_OPTIONS.find((tool) => tool.name === name)?.id)
    .filter((id): id is string => Boolean(id));
}

function environmentIdByName(name: string | undefined): string {
  if (!name) return NONE;
  return sandboxEnvironments.find((environment) => environment.name === name)?.id ?? NONE;
}

function itemFromFixture(schedule: Schedule): ScheduleItem {
  return {
    id: schedule.id,
    name: schedule.name,
    description: "",
    instructions: schedule.instructions,
    modelId: DEFAULT_MODEL,
    repository: schedule.setup.repositories[0] ?? NONE,
    variableSetId: schedule.setup.variableSetId ?? NONE,
    environmentId: environmentIdByName(schedule.setup.environment),
    tools: toolIds(schedule.setup.tools),
    cadence: {
      rule: normalizeCadenceRule(schedule.cadence, schedule.timeZoneId),
      timeZone: schedule.timeZoneId,
    },
    eachRun: schedule.setup.eachRun,
    ifStillRunning: schedule.setup.ifStillRunning ?? "queue",
    whereItRuns: "managed",
    learning: DEFAULT_LEARNING,
    state: schedule.state,
    ownerId: schedule.ownerId,
    lastRun: { status: schedule.lastRun.status, at: schedule.lastRun.at },
    runs: schedule.runs,
  };
}

export function initialItems(): ScheduleItem[] {
  return schedules.map(itemFromFixture);
}

/** Active schedules by next run, then paused ones by name. */
export function sortItems(items: readonly ScheduleItem[]): ScheduleItem[] {
  return [...items].sort((left, right) => {
    if (left.state !== right.state) return left.state === "active" ? -1 : 1;
    if (left.state === "paused") return left.name.localeCompare(right.name);
    const leftNext = nextRunOf(left)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightNext = nextRunOf(right)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return leftNext - rightNext;
  });
}

/* ----------------------------------------------------------------------------
   Words.
   -------------------------------------------------------------------------- */

function zoneLabels(timeZone: string) {
  const zone = timeZones.find((each) => each.id === timeZone);
  return { timeZoneLabel: zone?.label, timeZoneShortLabel: zone?.shortLabel };
}

/** "Every weekday at 08:00 · Oslo", for rows and sheet subtitles. */
export function cadenceShort(cadence: CadenceValue): string {
  return describeCadence(cadence.rule, {
    timeZone: cadence.timeZone,
    now: KIT_NOW,
    ...zoneLabels(cadence.timeZone),
  }).short;
}

/** "Runs every weekday at 08:00 Oslo time". */
export function cadenceSentence(cadence: CadenceValue): string {
  return describeCadence(cadence.rule, {
    timeZone: cadence.timeZone,
    now: KIT_NOW,
    ...zoneLabels(cadence.timeZone),
  }).sentence;
}

export function nextRunOf(item: Pick<ScheduleItem, "cadence" | "state">): Date | undefined {
  if (item.state === "paused") return undefined;
  return nextRuns(item.cadence.rule, {
    timeZone: item.cadence.timeZone,
    now: KIT_NOW,
    count: 1,
  })[0];
}

/** "Mon 28 Sep, 08:00, then Tue 29 Sep and Wed 30 Sep", in the viewer's zone. */
export function upcomingRunsLine(cadence: CadenceValue): string {
  const runs = nextRuns(cadence.rule, { timeZone: cadence.timeZone, now: KIT_NOW, count: 3 });
  return describeNextRuns(runs, { timeZone: KIT_TIME_ZONE, now: KIT_NOW });
}

export function runTimeLabel(date: Date): string {
  return formatRunTime(date, { timeZone: KIT_TIME_ZONE, now: KIT_NOW });
}

export interface ModelChoice {
  id: string;
  label: string;
  payer: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
}

const workspaceDefault = modelCatalog.find((model) => model.id === "codex:gpt-6-sol")!;

export const MODEL_CHOICES: ModelChoice[] = [
  {
    id: DEFAULT_MODEL,
    label: "Workspace default",
    payer: `${workspaceDefault.label} · ${workspaceDefault.payer}`,
    description: "Follows the workspace's default model at each run.",
    available: true,
  },
  ...modelCatalog.map((model) => ({
    id: model.id,
    label: model.label,
    payer: model.payer,
    description: model.description,
    available: model.available,
    unavailableReason: model.unavailableReason,
  })),
];

/** "Workspace default - GPT-6 Sol · Codex plan". */
export function modelLabel(modelId: string): string {
  const choice = MODEL_CHOICES.find((model) => model.id === modelId) ?? MODEL_CHOICES[0]!;
  return choice.id === DEFAULT_MODEL
    ? `Workspace default - ${choice.payer}`
    : `${choice.label} · ${choice.payer}`;
}

export const EACH_RUN_LABEL: Record<EachRun, string> = {
  new_chat: "New chat each run",
  ongoing_chat: "One ongoing chat",
};

export const IF_STILL_RUNNING_LABEL: Record<IfStillRunning, string> = {
  queue: "Queue the next run",
  skip: "Skip the next run",
};

export const MACHINE_NAME = "Bendik's Mac mini";

export const WHERE_LABEL: Record<WhereItRuns, string> = {
  managed: "Managed sandbox",
  machine: MACHINE_NAME,
};

export function variableSetName(id: string): string | undefined {
  return variableSets.find((set) => set.id === id)?.name;
}

export function environmentName(id: string): string | undefined {
  return sandboxEnvironments.find((environment) => environment.id === id)?.name;
}

export const REPOSITORY_OPTIONS = repositories;

const LEARNING_WORD = Object.fromEntries(
  learningModes.map((mode) => [mode.id, mode.label]),
) as Record<LearningMode, string>;

export function learningWord(choice: LearningChoice): string {
  return choice === "default" ? "Workspace default" : LEARNING_WORD[choice];
}

/** Any of the three learning choices differs from the workspace default. */
export function hasCustomLearning(learning: LearningDraft): boolean {
  return Object.values(learning).some((choice) => choice !== "default");
}

export function learningSummary(learning: LearningDraft): string {
  return hasCustomLearning(learning) ? "Custom agent learning" : "Workspace learning defaults";
}

export function advancedSummary(draft: ScheduleDraft, q27OngoingOnly: boolean): string {
  const parts = [EACH_RUN_LABEL[draft.eachRun]];
  if (draft.eachRun === "ongoing_chat" || !q27OngoingOnly) {
    parts.push(
      draft.ifStillRunning === "skip" ? "Skip if still running" : "Queue if still running",
    );
  }
  parts.push(WHERE_LABEL[draft.whereItRuns], learningSummary(draft.learning));
  return parts.join(" · ");
}

/**
 * The name the list shows when Name is left empty: the first sentence of the
 * instructions, without a leading "Every weekday at 08:00:" and at most 60
 * characters.
 */
export function deriveName(instructions: string): string {
  const withoutCadence = withoutCadencePrefix(instructions);
  const firstSentence = withoutCadence.split(/(?<=[.!?])\s|\n/)[0]?.replace(/[.!?]$/, "") ?? "";
  const clean = firstSentence.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const capitalized = clean.charAt(0).toLocaleUpperCase() + clean.slice(1);
  if (capitalized.length <= 60) return capitalized;
  let cut = capitalized.slice(0, 60);
  cut = cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "");
  // "…merged pull requests in…" reads broken; end on a word that carries meaning.
  while (DANGLING_WORD.test(cut)) cut = cut.replace(DANGLING_WORD, "");
  return `${cut}…`;
}

const DANGLING_WORD = /\s+(a|an|and|at|by|for|from|in|into|of|on|or|the|to|with)$/i;

/**
 * "Every weekday at 08:00: summarize what changed" -> "Summarize what changed".
 * The When section owns the cadence, so instructions shouldn't repeat it.
 */
export function withoutCadencePrefix(instructions: string): string {
  const text = instructions.trim().replace(/^every\b.{0,40}?:\s+/i, "");
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

export function displayName(draft: Pick<ScheduleDraft, "name" | "instructions">): string {
  return draft.name.trim() || deriveName(draft.instructions) || "Untitled schedule";
}

/* ----------------------------------------------------------------------------
   Drafts.
   -------------------------------------------------------------------------- */

/** One hour from the kit clock, on the hour: Sat 26 Sep, 15:00 in Oslo. */
function oneTimeInAnHour(): CadenceValue {
  return {
    timeZone: KIT_TIME_ZONE,
    rule: { frequency: "once", date: "2026-09-26", time: "15:00" },
  };
}

export function emptyDraft(questions: SchedulesQuestions): ScheduleDraft {
  return {
    instructions: "",
    modelId: DEFAULT_MODEL,
    repository: NONE,
    variableSetId: NONE,
    environmentId: NONE,
    tools: [],
    cadence: questions.q23WeekdayDefault
      ? { timeZone: KIT_TIME_ZONE, rule: { frequency: "weekdays", time: DEFAULT_CADENCE_TIME } }
      : oneTimeInAnHour(),
    name: "",
    description: "",
    eachRun: "new_chat",
    ifStillRunning: "queue",
    whereItRuns: "managed",
    learning: DEFAULT_LEARNING,
  };
}

export function draftFromTemplate(
  templateId: string,
  questions: SchedulesQuestions,
): ScheduleDraft {
  const template = scheduleTemplates.find((each) => each.id === templateId);
  const base = emptyDraft(questions);
  if (!template) return base;
  return {
    ...base,
    instructions: withoutCadencePrefix(template.instructions),
    name: template.name,
    cadence: {
      timeZone: KIT_TIME_ZONE,
      rule: normalizeCadenceRule(template.cadence, KIT_TIME_ZONE),
    },
    tools: template.id === "template-dependency-pr" ? ["github"] : ["slack"],
    repository: template.id === "template-dependency-pr" ? "acme-robotics/platform" : NONE,
    variableSetId: template.id === "template-cost-anomaly" ? "vs-aws-production" : NONE,
  };
}

export function draftOf(item: ScheduleItem): ScheduleDraft {
  const {
    instructions,
    modelId,
    repository,
    variableSetId,
    environmentId,
    tools,
    cadence,
    name,
    description,
    eachRun,
    ifStillRunning,
    whereItRuns,
    learning,
  } = item;
  return {
    instructions,
    modelId,
    repository,
    variableSetId,
    environmentId,
    tools,
    cadence,
    name,
    description,
    eachRun,
    ifStillRunning,
    whereItRuns,
    learning,
  };
}

export function duplicateDraft(item: ScheduleItem): ScheduleDraft {
  return { ...draftOf(item), name: `${displayName(item)} (copy)` };
}

let createdCount = 0;

export function createItem(draft: ScheduleDraft): ScheduleItem {
  createdCount += 1;
  return {
    ...draft,
    name: displayName(draft),
    id: `sched-new-${createdCount}`,
    state: "active",
    ownerId: you.id,
    lastRun: { status: "never" },
    runs: [],
  };
}

/* ----------------------------------------------------------------------------
   Permissions: the viewer is Bendik, a workspace admin.
   -------------------------------------------------------------------------- */

export interface SchedulePermissions {
  own: boolean;
  ownerName: string;
  ownerFirstName: string;
  canEditOrRun: boolean;
  canPauseOrDelete: boolean;
  /** Why the Active switch is off (Pause and Resume). */
  manageReason?: string;
}

export function permissionsFor(
  item: ScheduleItem,
  questions: SchedulesQuestions,
): SchedulePermissions {
  const owner = personById(item.ownerId);
  const firstName = owner.name.split(" ")[0] ?? owner.name;
  if (owner.id === you.id) {
    return {
      own: true,
      ownerName: owner.name,
      ownerFirstName: firstName,
      canEditOrRun: true,
      canPauseOrDelete: true,
    };
  }
  return {
    own: false,
    ownerName: owner.name,
    ownerFirstName: firstName,
    canEditOrRun: false,
    canPauseOrDelete: questions.q26AdminsManage,
    manageReason: questions.q26AdminsManage
      ? undefined
      : `Only ${owner.name} can pause or delete it.`,
  };
}
