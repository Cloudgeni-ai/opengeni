/**
 * Pure helpers for the Automations pages: when an automation runs in words
 * (its schedule and its event triggers), the next run, the list order, the
 * derived name, and the create/update requests built from the form draft.
 * The words, cadences and names come from @opengeni/react/automations, so
 * these pages and the embeddable Automations panel agree.
 */
import {
  formatRunTime,
  type CadenceFrequency,
  type CadenceValue,
} from "@opengeni/react/ui/cadence-picker";
import { t } from "@opengeni/react/app/lib/console-text";
import {
  AUTOMATION_FREQUENCIES,
  AUTOMATION_NAME_MAX_LENGTH,
  automationCadence,
  automationDraftFromTemplate,
  automationTemplatesFor,
  automationTemplateWhenWords,
  builtinAutomationTemplates,
  automationCadenceIssue,
  automationCadenceRepeats,
  automationCadenceWords,
  automationNextRun,
  automationRunEventsLabel,
  automationScheduleSpec,
  automationScheduleWords,
  automationWhenSentence as whenSentence,
  automationWhenWords as whenWords,
  defaultAutomationCadence,
  deriveAutomationName,
  emptyEventTriggersDraft,
  eventTriggersInputFrom,
  hasEventTriggers,
  isFinishedOnce,
  newEventTriggerDraft,
  sameEventTriggers,
  viewerTimeZone,
  type AutomationTemplate,
  type EventTriggersDraft,
} from "@opengeni/react/automations";
import {
  agentConfigFromFormState,
  newScheduledTaskFormState,
  scheduledTaskStateLabel,
  taskMetadataFromFormState,
  type ScheduledTaskFormState,
} from "@/lib/scheduled-tasks";
import type {
  CreateScheduledTaskRequest,
  EventSource,
  McpConnectionAccountSelection,
  UpdateScheduledTaskRequest,
  VaultPolicy,
} from "@opengeni/sdk";
import { GOOGLE_DRIVE_PUBLICATION_SERVER_ID } from "@opengeni/contracts/google-drive";
import { PERSONAL_GITHUB_CONNECTION_SURFACE_ID } from "@opengeni/contracts/personal-github";
import { mergeResourceRefs } from "@opengeni/contracts";
import { connectionAccountChoices } from "@opengeni/react/app/components/capabilities/session-connection-accounts";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskScheduleSpec,
  Session,
} from "@opengeni/react/app/types";

export { hasEventTriggers, isFinishedOnce, viewerTimeZone };

/** Agent learning overrides sent with an edit (not in the SDK's update type yet). */
export interface ScheduleLearningUpdate {
  scope: "personal" | "workspace";
  baselineScope?: "personal" | "workspace";
  operationId: string;
  expectedVersion: number;
  settings: NonNullable<ScheduledTaskFormState["agentLearning"]>;
}

/** The frequencies a schedule can store (no day of month yet). */
export const SCHEDULE_FREQUENCIES: readonly CadenceFrequency[] = AUTOMATION_FREQUENCIES;

/** "Every weekday at 09:00, your time": the default for a new schedule. */
export function defaultCadence(timeZone: string = viewerTimeZone()): CadenceValue {
  return defaultAutomationCadence(timeZone);
}

/** The stored spec as an editable cadence, or null for on-demand schedules. */
export function cadenceOfSchedule(
  schedule: ScheduledTaskScheduleSpec,
  fallbackTimeZone: string = viewerTimeZone(),
): CadenceValue | null {
  return automationCadence(schedule, fallbackTimeZone);
}

export function specFromCadence(value: CadenceValue, now: Date): ScheduledTaskScheduleSpec {
  return automationScheduleSpec(value, now);
}

export interface ScheduleWords {
  /** "Every weekday at 08:00 · Oslo", for rows and meta lines. */
  short: string;
  /** "Runs every weekday at 08:00 Oslo time", for sentences. */
  sentence: string;
}

export function scheduleWords(schedule: ScheduledTaskScheduleSpec, now: Date): ScheduleWords {
  return automationScheduleWords(t, schedule, now);
}

export function cadenceWords(cadence: CadenceValue, now: Date): ScheduleWords {
  return automationCadenceWords(t, cadence, now);
}

/** The next run, or null when paused, on demand, or no runs are left. */
export function nextRunOf(task: ScheduledTask, now: Date): Date | null {
  if (!scheduledTaskStateLabel(task).active) return null;
  return automationNextRun({ ...task, status: "active" }, now);
}

/** Events can start it now: it is on, has triggers and has not finished. */
export function listensForEvents(task: ScheduledTask): boolean {
  return scheduledTaskStateLabel(task).active && hasEventTriggers(task) && !isFinishedOnce(task);
}

/**
 * When it runs, in one line: "Every weekday at 08:00 · Oslo",
 * "pull_request.opened from GitHub", or both.
 */
export function automationWhenWords(
  task: Pick<ScheduledTask, "schedule" | "events">,
  sources: readonly Pick<EventSource, "id" | "name">[],
  now: Date,
): string {
  return whenWords(t, task, sources, now);
}

/**
 * When it runs, as the Overview's sentence: "Runs every weekday at 08:00 Oslo
 * time, and when a matching event arrives", or "Runs once, on the first
 * matching event".
 */
export function automationWhenSentence(
  task: Pick<ScheduledTask, "schedule" | "events">,
  now: Date,
): string {
  return whenSentence(t, task, now);
}

/** "Mon 28 Sep, 08:00" or "Today, 14:00" in the viewer's zone. */
export function runTimeLabel(date: Date, now: Date): string {
  return formatRunTime(date, { timeZone: viewerTimeZone(), now, text: t });
}

/**
 * The events an event run carried, in a few words: the first event's summary
 * and how many more came with it. Null for a run no event started.
 */
export function runEventsLabel(run: Pick<ScheduledTaskRun, "eventOccurrence">): string | null {
  return automationRunEventsLabel(t, run);
}

export function cadenceIssue(cadence: CadenceValue | null, now: Date): string | null {
  return automationCadenceIssue(t, cadence, now);
}

/** The cadence runs more than once; a run-once automation can't have one. */
export function cadenceRepeats(cadence: CadenceValue | null): boolean {
  return automationCadenceRepeats(cadence);
}

/**
 * Active schedules by next run (soonest first), then automations waiting for
 * events, then everything that won't fire (paused, sync off, on demand, no
 * runs left, finished) by name.
 */
export function sortSchedulesForList(tasks: readonly ScheduledTask[], now: Date): ScheduledTask[] {
  const keyed = tasks.map((task) => ({
    task,
    next: nextRunOf(task, now)?.getTime() ?? null,
    listening: listensForEvents(task),
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

/**
 * The name a schedule gets when Name is left empty: the first sentence of the
 * instructions, without a leading "Every weekday at 08:00:" and at most 60
 * characters, ending on a word that carries meaning.
 */
export function deriveScheduleName(instructions: string): string {
  return deriveAutomationName(instructions);
}

export const NAME_MAX_LENGTH = AUTOMATION_NAME_MAX_LENGTH;

/* ----------------------------------------------------------------------------
   The form draft.
   -------------------------------------------------------------------------- */

/**
 * Everything the form edits: the stored-task form state (model, run mode,
 * compute, tools, learning) plus the cadence and the attachments the old
 * editor never showed.
 */
export interface ScheduleDraft extends ScheduledTaskFormState {
  /** Null when it runs only on events or with Run now. */
  cadence: CadenceValue | null;
  /** Its event triggers and their run policy; no triggers when it runs on a schedule only. */
  events: EventTriggersDraft;
  rigId: string | null;
  /** Who can see the schedule and the chats it creates. */
  visibility: "private" | "workspace";
  /** Vaults every run may use. Undefined: all the owner can reach. */
  vaultPolicy?: VaultPolicy;
}

/** A selected policy, or undefined for "all" (the server default). */
export function narrowedVaultPolicy(policy: VaultPolicy | undefined): VaultPolicy | undefined {
  return policy?.mode === "selected" ? policy : undefined;
}

export interface DraftDefaults {
  includeOpenGeniTool: boolean;
  model?: string;
  reasoningEffort?: ScheduledTaskFormState["reasoningEffort"];
  modelFollowsDefault?: boolean;
  defaultSandboxBackend?: ScheduledTaskFormState["sandboxBackend"] | undefined;
  defaultMachineSandboxId?: string;
  workspaceDefaultToolIds?: readonly string[];
}

function formDefaults(defaults: DraftDefaults) {
  return {
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    modelFollowsDefault: defaults.modelFollowsDefault,
    defaultSandboxBackend: defaults.defaultSandboxBackend || undefined,
    defaultMachineSandboxId: defaults.defaultMachineSandboxId,
    workspaceDefaultToolIds: defaults.workspaceDefaultToolIds,
  };
}

export function newScheduleDraft(defaults: DraftDefaults, timeZone?: string): ScheduleDraft {
  return {
    ...newScheduledTaskFormState(defaults.includeOpenGeniTool, [], formDefaults(defaults)),
    cadence: defaultCadence(timeZone),
    events: emptyEventTriggersDraft(),
    rigId: null,
    visibility: "workspace",
  };
}

/**
 * The built-in templates this deployment can offer: the ones on events only
 * where events run. They are the shared ones from @opengeni/react, so these
 * pages and the embeddable panel offer the same.
 */
export function scheduleTemplates(eventTriggers: boolean): AutomationTemplate[] {
  return automationTemplatesFor(builtinAutomationTemplates(t), {
    eventTriggers,
    workspaceEvents: true,
  });
}

export function templateById(
  id: string | undefined,
  eventTriggers = true,
): AutomationTemplate | undefined {
  return scheduleTemplates(eventTriggers).find((template) => template.id === id);
}

/**
 * The draft a template starts: its name, instructions, schedule and triggers.
 * A trigger takes the viewer's source of the kind it asks for once sources
 * load; until then it remembers the kind.
 */
export function draftFromTemplate(
  template: AutomationTemplate,
  defaults: DraftDefaults,
  options: { sources?: readonly EventSource[] | undefined; timeZone?: string | undefined } = {},
): ScheduleDraft {
  const base = newScheduleDraft(defaults, options.timeZone);
  const shared = automationDraftFromTemplate(template, {
    sources: options.sources,
    timeZone: base.cadence?.timeZone,
  });
  return {
    ...base,
    name: shared.name,
    prompt: shared.instructions,
    cadence: shared.cadence,
    events: shared.events,
  };
}

/** A new automation starting from one source: a trigger on it, no schedule. */
export function draftForEventSource(
  sourceId: string,
  defaults: DraftDefaults,
  timeZone?: string,
): ScheduleDraft {
  const base = newScheduleDraft(defaults, timeZone);
  return {
    ...base,
    cadence: null,
    events: { ...base.events, triggers: [newEventTriggerDraft(sourceId)] },
  };
}

/** "Every weekday at 08:00" or "When a pull request opens", for a template card. */
export function templateCadenceLabel(template: AutomationTemplate, now: Date): string {
  return automationTemplateWhenWords(t, template, now);
}

/* ----------------------------------------------------------------------------
   Requests.
   -------------------------------------------------------------------------- */

export function scheduleName(draft: Pick<ScheduleDraft, "name" | "prompt">): string {
  return draft.name.trim() || deriveScheduleName(draft.prompt) || "Untitled automation";
}

/** The `events` of a create request: present only with triggers. */
function eventsForCreate(draft: Pick<ScheduleDraft, "events">) {
  return draft.events.triggers.length > 0 ? { events: eventTriggersInputFrom(draft.events) } : {};
}

/**
 * Only "one ongoing chat" and "an existing chat" can overlap a running turn,
 * so a new-chat schedule is always saved with the default overlap policy
 * (steer, for one, only exists for runs into a chat).
 */
export function overlapPolicyForCreate(
  draft: Pick<ScheduleDraft, "runMode" | "overlapPolicy">,
): ScheduleDraft["overlapPolicy"] {
  return draft.runMode === "new_session_per_run" ? "allow_concurrent" : draft.overlapPolicy;
}

/** Existing chats, including one already created for a schedule, own their settings. */
export function scheduleInheritsChatSettings(
  task: Pick<ScheduledTask, "runMode" | "reusableSessionId">,
): boolean {
  return (
    task.runMode === "existing_session" ||
    (task.runMode === "reusable_session" && Boolean(task.reusableSessionId))
  );
}

/**
 * Which account groups a person pinned in this edit. Only groups they changed
 * become pins; a newly enabled connector stays unpinned. A move, a tool change
 * or clearing the pins re-checks the retained pins against the destination.
 */
export function scheduleConnectionAccountIntent(input: {
  /** The schedule's pins; every other connector shows its current accounts. */
  saved: McpConnectionAccountSelection[];
  editedServerIds: string[];
  destinationChanged: boolean;
  toolsChanged: boolean;
  pinsCleared?: boolean;
}) {
  const changedServerIds = [...new Set(input.editedServerIds)];
  return {
    choices: connectionAccountChoices(input.saved),
    changedServerIds,
    // A move must also discard pins the destination cannot use.
    changed:
      input.destinationChanged ||
      input.toolsChanged ||
      input.pinsCleared === true ||
      changedServerIds.length > 0,
  };
}

/**
 * The pins to save: retained pins the destination can still use, minus the
 * connectors a person re-picked, plus those new picks. Untouched connectors
 * stay unpinned and follow the owner's current accounts.
 */
export function mergeSchedulePinnedAccounts(
  saved: McpConnectionAccountSelection[],
  selections: McpConnectionAccountSelection[],
  editableServerIds: string[],
  destination: {
    selectedServerIds: string[];
    resources: ScheduleDraft["resources"];
    chat?: Pick<Session, "resources" | "firstPartyMcpTools" | "firstPartyMcpPermissions">;
  },
): McpConnectionAccountSelection[] {
  const eligible = new Set(destination.selectedServerIds);
  eligible.delete(PERSONAL_GITHUB_CONNECTION_SURFACE_ID);
  eligible.delete(GOOGLE_DRIVE_PUBLICATION_SERVER_ID);
  if (
    mergeResourceRefs(destination.chat?.resources ?? [], destination.resources).some(
      (resource) => resource.kind === "repository" && resource.connectionType === "github_personal",
    )
  )
    eligible.add(PERSONAL_GITHUB_CONNECTION_SURFACE_ID);
  const replaced = new Set(editableServerIds);
  return [
    ...saved.filter(
      (selection) => eligible.has(selection.serverId) && !replaced.has(selection.serverId),
    ),
    ...selections.filter((selection) => selection.serverId !== GOOGLE_DRIVE_PUBLICATION_SERVER_ID),
  ];
}

export function createRequestFromDraft(
  draft: ScheduleDraft,
  options: {
    now: Date;
    learningScope: "personal" | "workspace";
  },
): CreateScheduledTaskRequest {
  const schedule: ScheduledTaskScheduleSpec = draft.cadence
    ? specFromCadence(draft.cadence, options.now)
    : { type: "manual" };
  if (draft.runMode === "existing_session")
    return {
      name: scheduleName(draft),
      schedule,
      prompt: draft.prompt.trim(),
      targetSessionId: draft.targetSessionId,
      ...(draft.visibility === "private" ? { visibility: "private" as const } : {}),
      overlapPolicy: overlapPolicyForCreate(draft),
      metadata: taskMetadataFromFormState(draft),
      ...eventsForCreate(draft),
    };
  return {
    ...(draft.agentLearning && Object.keys(draft.agentLearning).length
      ? {
          agentLearning: {
            scope: options.learningScope,
            settings: draft.agentLearning,
          },
        }
      : {}),
    name: scheduleName(draft),
    schedule,
    ...(draft.visibility === "private" ? { visibility: "private" as const } : {}),
    runMode: draft.runMode,
    overlapPolicy: overlapPolicyForCreate(draft),
    metadata: taskMetadataFromFormState(draft),
    ...(draft.pinnedAccounts?.length ? { pinnedAccounts: draft.pinnedAccounts } : {}),
    agentConfig: agentConfigFromFormState(draft),
    ...(draft.rigId ? { rigId: draft.rigId } : {}),
    ...(narrowedVaultPolicy(draft.vaultPolicy) ? { vaultPolicy: draft.vaultPolicy } : {}),
    ...eventsForCreate(draft),
  };
}

function sameCadence(left: CadenceValue | null, right: CadenceValue | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The PATCH for an edited schedule. The schedule spec, vault policy and
 * Sandbox Environment are sent only when they changed, so an untouched field
 * the editor can't fully express (an interval end, a vault this viewer can't
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
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const targetChanged =
    initial.runMode !== draft.runMode || initial.targetSessionId !== draft.targetSessionId;
  const inheritsChatSettings =
    draft.runMode === "existing_session" ||
    (draft.runMode === task.runMode && scheduleInheritsChatSettings(task));
  const materializedReusable = inheritsChatSettings && draft.runMode === "reusable_session";
  const editableConfig = (form: ScheduleDraft) => {
    if (!materializedReusable) return agentConfigFromFormState(form, task, initial);
    const {
      pinnedAccounts: _pins,
      pinnedAccountsRequired: _pinsRequired,
      slackBotConnectionId: _bot,
      slackBotChannelId: _channel,
      ...retained
    } = {
      pinnedAccounts: undefined,
      pinnedAccountsRequired: undefined,
      ...task.agentConfig,
    };
    return {
      ...retained,
      prompt: form.prompt,
      resources: form.resources,
      ...(form.slackBotConnectionId ? { slackBotConnectionId: form.slackBotConnectionId } : {}),
      ...(form.slackBotConnectionId && form.slackBotChannelId
        ? { slackBotChannelId: form.slackBotChannelId }
        : {}),
    };
  };
  const oldConfig = editableConfig(initial);
  const nextConfig = editableConfig(draft);
  const onlyPromptChanged = same({ ...oldConfig, prompt: nextConfig.prompt }, nextConfig);
  const oldMetadata = taskMetadataFromFormState(initial, task);
  const nextMetadata = taskMetadataFromFormState(draft, task);
  return {
    expectedExecutionDigest: task.executionDigest,
    ...(options.agentLearning && draft.runMode !== "existing_session"
      ? { agentLearning: options.agentLearning }
      : {}),
    ...(scheduleName(initial) === scheduleName(draft) ? {} : { name: scheduleName(draft) }),
    ...(sameCadence(initial.cadence, draft.cadence)
      ? {}
      : {
          schedule: draft.cadence
            ? specFromCadence(draft.cadence, options.now)
            : ({ type: "manual" } as const),
        }),
    ...(targetChanged
      ? {
          runMode: draft.runMode,
          targetSessionId: draft.runMode === "existing_session" ? draft.targetSessionId : null,
        }
      : {}),
    ...(overlapPolicyForCreate(initial) === overlapPolicyForCreate(draft)
      ? {}
      : { overlapPolicy: overlapPolicyForCreate(draft) }),
    ...(initial.visibility === draft.visibility ? {} : { visibility: draft.visibility }),
    // Triggers are sent whole, and only when they changed; none removes them all.
    ...(sameEventTriggers(initial.events, draft.events)
      ? {}
      : {
          events:
            draft.events.triggers.length > 0
              ? eventTriggersInputFrom(draft.events)
              : { triggers: [] },
        }),
    ...(same(oldMetadata, nextMetadata) ? {} : { metadata: nextMetadata }),
    // An existing-chat schedule has no pins; moving into a chat drops them.
    ...(draft.runMode === "existing_session" ||
    same(initial.pinnedAccounts ?? [], draft.pinnedAccounts ?? [])
      ? {}
      : { pinnedAccounts: draft.pinnedAccounts ?? [] }),
    ...(draft.runMode === "existing_session" || onlyPromptChanged
      ? initial.prompt === draft.prompt
        ? {}
        : { prompt: draft.prompt }
      : same(oldConfig, nextConfig)
        ? {}
        : { agentConfig: nextConfig }),
    ...(inheritsChatSettings || initial.rigId === draft.rigId ? {} : { rigId: draft.rigId }),
    ...(inheritsChatSettings ||
    same(narrowedVaultPolicy(initial.vaultPolicy), narrowedVaultPolicy(draft.vaultPolicy))
      ? {}
      : { vaultPolicy: narrowedVaultPolicy(draft.vaultPolicy) ?? { mode: "all" } }),
  };
}

/* ----------------------------------------------------------------------------
   Errors.
   -------------------------------------------------------------------------- */

/**
 * What the server said, in a sentence, without the "Opengeni API 422:" prefix
 * or the request reference (that belongs in Technical details).
 */
export function scheduleErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const clean = raw
    .replace(/\s*Reference:\s*[\w-]+\.?\s*$/i, "")
    .replace(/^(?:Opengeni|OpenGeni) API \d+:\s*/i, "")
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
   Create with Opengeni.
   -------------------------------------------------------------------------- */

/**
 * The first message of a "Create with Opengeni" chat. The person says what
 * should happen and how often. Setup guidance belongs in the bundled
 * schedules Skill, which the agent reads when this request is relevant.
 */
export function scheduleAgentOpeningMessage(request: string, timeZone: string): string {
  return [
    "Help me create an automation in this workspace.",
    "",
    request.trim(),
    "",
    `My time zone is ${timeZone}.`,
  ].join("\n");
}
