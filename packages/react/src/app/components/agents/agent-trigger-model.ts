/**
 * The light "Add trigger" flow on an agent's page (docs/agents.md, Starts
 * when): what a new trigger starts from, what it saves as and why a save was
 * refused. A trigger is an ordinary automation whose runs are new chats with
 * the agent. Pure; `AgentTriggerDialog` renders it.
 */
import type {
  Agent,
  AgentTemplateTrigger,
  CreateScheduledTaskRequest,
  EventSource,
  ResourceRef,
  ScheduledTaskEventsInput,
  ScheduledTaskScheduleSpec,
} from "@opengeni/sdk";

import {
  automationCreateRequest,
  automationWhenWords,
  defaultAutomationCadence,
  newAutomationDraft,
  validateAutomationDraft,
  type AutomationDraft,
  type AutomationDraftIssues,
} from "../../../components/automations/automation-model";
import {
  automationDraftFromTemplate,
  eventSourceFitsTemplate,
  withTemplateSources,
} from "../../../components/automations/automation-template-model";
import {
  emptyEventTriggersDraft,
  newEventTriggerDraft,
} from "../../../components/automations/event-trigger-model";
import type { OpenGeniText } from "../../../messages/runtime";
import { apiErrorFacts, userErrorText } from "../../../ui/api-error";

/** What a run says when the person types no message. */
export const AGENT_TRIGGER_EVENT_MESSAGE = "Handle the event that started this run.";
export const AGENT_TRIGGER_SCHEDULE_MESSAGE = "Do your scheduled work.";

/** A refused shared trigger, in words. */
export const AGENT_TRIGGER_SHARED_DENIED =
  "You can't add automations shared with this workspace. Ask an admin for access.";

const NAME_MAX_LENGTH = 200;

/** How a blank trigger starts: on an event or on a schedule. */
export type AgentTriggerKind = "event" | "schedule";

/**
 * Where a new trigger starts: a suggestion's events, conditions, schedule and
 * instructions, else one event (or, where events don't run, the default
 * schedule). The message is empty unless a suggestion has one: it is optional.
 */
export function agentTriggerDraft(
  suggestion: AgentTemplateTrigger | undefined,
  options: {
    eventTriggers: boolean;
    sources?: readonly EventSource[] | undefined;
    timeZone?: string | undefined;
  },
): AutomationDraft {
  if (suggestion) {
    return automationDraftFromTemplate(
      {
        id: "agent-trigger",
        name: suggestion.name,
        description: suggestion.name,
        instructions: suggestion.instructions,
        schedule: suggestion.schedule,
        triggers: suggestion.triggers,
      },
      { sources: options.sources, timeZone: options.timeZone },
    );
  }
  return agentTriggerDraftOfKind(
    options.eventTriggers ? "event" : "schedule",
    newAutomationDraft({ cadence: null }),
    options.sources,
    options.timeZone,
  );
}

/** The draft switched to start on an event (one, on the only source when there is one) or a schedule. */
export function agentTriggerDraftOfKind(
  kind: AgentTriggerKind,
  draft: AutomationDraft,
  sources: readonly EventSource[] | undefined,
  timeZone?: string,
): AutomationDraft {
  if (kind === "schedule") {
    return {
      ...draft,
      cadence: draft.cadence ?? defaultAutomationCadence(timeZone),
      events: emptyEventTriggersDraft(),
    };
  }
  const only = sources?.length === 1 ? sources[0]!.id : "";
  return {
    ...draft,
    cadence: null,
    events:
      draft.events.triggers.length > 0
        ? draft.events
        : { ...emptyEventTriggersDraft(), triggers: [newEventTriggerDraft(only)] },
  };
}

/**
 * Triggers still without a source take one once sources load: a
 * suggestion's its own kind, a blank one the only source there is. The same
 * draft when nothing changed.
 */
export function agentTriggerWithSources(
  events: AutomationDraft["events"],
  sources: readonly EventSource[] | undefined,
): AutomationDraft["events"] {
  const filled = withTemplateSources(events, sources);
  const only = sources?.length === 1 ? sources[0]!.id : "";
  if (!only || !filled.triggers.some((trigger) => !trigger.sourceId && !trigger.templateSource))
    return filled;
  return {
    ...filled,
    triggers: filled.triggers.map((trigger) =>
      trigger.sourceId || trigger.templateSource ? trigger : { ...trigger, sourceId: only },
    ),
  };
}

/** The message each run sends: the typed one, else a short one for how it starts. */
export function agentTriggerMessage(draft: Pick<AutomationDraft, "instructions" | "events">) {
  const typed = draft.instructions.trim();
  if (typed) return typed;
  return draft.events.triggers.length > 0
    ? AGENT_TRIGGER_EVENT_MESSAGE
    : AGENT_TRIGGER_SCHEDULE_MESSAGE;
}

/**
 * Whether the draft can't be saved yet: no schedule and no event, or the
 * schedule or events as the full form checks them. The message never is: it
 * has a default.
 */
export function agentTriggerIssues(
  t: OpenGeniText,
  draft: AutomationDraft,
  sources: readonly Pick<EventSource, "id" | "kind">[],
  now: Date,
): AutomationDraftIssues {
  const issues = validateAutomationDraft(
    t,
    { ...draft, instructions: agentTriggerMessage(draft) },
    sources,
    now,
  );
  if (!draft.cadence && draft.events.triggers.length === 0) issues.when = "Choose when it starts.";
  return issues;
}

/**
 * The kind of source a suggestion's trigger asks for, while the person has
 * none of it: what "Add a source" should open. Undefined when every trigger
 * has a source it can use.
 */
export function agentTriggerMissingSource(
  draft: AutomationDraft,
  sources: readonly EventSource[] | undefined,
): NonNullable<AutomationDraft["events"]["triggers"][number]["templateSource"]> | undefined {
  if (!sources) return undefined;
  for (const trigger of draft.events.triggers) {
    if (trigger.sourceId || !trigger.templateSource) continue;
    const wanted = trigger.templateSource;
    if (!sources.some((source) => eventSourceFitsTemplate(wanted, source))) return wanted;
  }
  return undefined;
}

/** A suggestion keeps its name after the agent's, so the agent page knows it is set up. */
export function agentTriggerName(
  t: OpenGeniText,
  agent: Pick<Agent, "name">,
  suggestion: Pick<AgentTemplateTrigger, "name"> | undefined,
  request: { schedule: ScheduledTaskScheduleSpec; events?: ScheduledTaskEventsInput | undefined },
  sources: readonly Pick<EventSource, "id" | "name">[],
  now: Date,
): string {
  const when =
    suggestion?.name ??
    automationWhenWords(
      t,
      { schedule: request.schedule, events: request.events } as Parameters<
        typeof automationWhenWords
      >[1],
      sources,
      now,
    );
  return `${agent.name}: ${when}`.slice(0, NAME_MAX_LENGTH);
}

/**
 * The automation a trigger saves as: a new chat with the agent on every run,
 * shared like the agent (an Only me agent's trigger is Only me, any other is
 * shared with the workspace), with the repositories picked for it.
 */
export function agentTriggerCreateRequest(
  t: OpenGeniText,
  input: {
    agent: Pick<Agent, "id" | "name" | "visibility">;
    suggestion?: Pick<AgentTemplateTrigger, "name"> | undefined;
    draft: AutomationDraft;
    resources?: readonly ResourceRef[] | undefined;
    sources: readonly Pick<EventSource, "id" | "name">[];
    now: Date;
  },
): CreateScheduledTaskRequest {
  const base = automationCreateRequest(
    t,
    { ...input.draft, instructions: agentTriggerMessage(input.draft) },
    { kind: "new_chat" },
    input.now,
  );
  if (!("agentConfig" in base) || !base.agentConfig) return base;
  return {
    ...base,
    name: agentTriggerName(t, input.agent, input.suggestion, base, input.sources, input.now),
    visibility: input.agent.visibility === "private" ? "private" : "workspace",
    agentConfig: {
      ...base.agentConfig,
      agentId: input.agent.id,
      resources: [...(input.resources ?? [])],
    },
  };
}

/** Why a save was refused, in words; a shared trigger the person may not add says so. */
export function agentTriggerSaveError(error: unknown, visibility: "private" | "workspace"): string {
  if (apiErrorFacts(error).status === 403 && visibility !== "private")
    return AGENT_TRIGGER_SHARED_DENIED;
  return userErrorText(error);
}
