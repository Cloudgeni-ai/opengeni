/**
 * An agent's triggers in words (docs/agents.md, When it works): each trigger
 * as one readable sentence ("When an issue in acme/api gets the label bug"),
 * whose access it runs with ("Runs as you"), who may switch or remove it, and
 * the outcome-first choices of Add trigger with the sentence that confirms
 * one. Raw event names stay in the details (`agentTriggerDetails`). Pure.
 */
import type {
  AgentTemplateTrigger,
  ResourceRef,
  ScheduledTask,
  ScheduledTaskScheduleSpec,
} from "@opengeni/sdk";
import {
  AgentTemplateTrigger as AgentTemplateTriggerSchema,
  commonAgentTriggers,
} from "@opengeni/contracts";

import { automationScheduleWords } from "../../../components/automations/automation-model";
import type { OpenGeniText } from "../../../messages/runtime";
import { AGENT_TRIGGER_REPOSITORY_FIELD } from "./agent-trigger-model";

/* ----------------------------------------------------------------------------
   One trigger, whatever it was saved or suggested as.
   -------------------------------------------------------------------------- */

type Condition = { field: string; op: string; value?: unknown };

/** One event trigger: the kind of source it listens on, its events and conditions. */
export interface AgentTriggerListen {
  /** "github", "slack", "webhook", "workspace", or undefined when unknown. */
  sourceKind?: string | undefined;
  /** The source's own name ("GitHub", "Deploys"), when known. */
  sourceName?: string | undefined;
  /** The source's id, to find its catalog wording. */
  sourceId?: string | undefined;
  eventTypes: readonly string[];
  conditions: readonly Condition[];
}

export interface AgentTriggerShape {
  /** Null or manual: it runs only on its events. */
  schedule: ScheduledTaskScheduleSpec | AgentTemplateTrigger["schedule"] | null;
  listens: readonly AgentTriggerListen[];
  /** Repositories a scheduled run opens (`owner/name`). */
  repositories: readonly string[];
}

/** `owner/name` of a repository resource, from its clone URL. */
export function repositoryNameOf(resource: Pick<ResourceRef, "kind"> & { uri?: string }): string {
  const uri = resource.uri ?? "";
  const path = uri
    .replace(/^[a-z+]+:\/\/[^/]+\//iu, "")
    .replace(/^git@[^:]+:/iu, "")
    .replace(/\.git$/iu, "")
    .replace(/\/+$/u, "");
  return path || uri;
}

/** The repositories a saved trigger's runs open: the ones on its task. */
export function agentTriggerRepositoriesOf(task: Pick<ScheduledTask, "agentConfig">): string[] {
  return (task.agentConfig.resources ?? []).flatMap((resource) =>
    resource.kind === "repository" ? [repositoryNameOf(resource)] : [],
  );
}

/** A saved trigger (an agent's automation) as a shape. */
export function agentTriggerShapeOfTask(
  task: Pick<ScheduledTask, "schedule" | "events" | "agentConfig">,
  sources: readonly { id: string; name: string; kind?: string | undefined }[],
): AgentTriggerShape {
  return {
    schedule: task.schedule,
    listens: (task.events?.triggers ?? []).map((trigger) => {
      const source = sources.find((entry) => entry.id === trigger.sourceId);
      return {
        sourceId: trigger.sourceId,
        sourceKind: source?.kind,
        sourceName: source?.name,
        eventTypes: trigger.eventTypes,
        conditions: (trigger.conditions ?? []) as readonly Condition[],
      };
    }),
    repositories: agentTriggerRepositoriesOf(task),
  };
}

/** A suggested trigger (a ready-made agent's, or a common one) as a shape. */
export function agentTriggerShapeOfSuggestion(suggestion: AgentTemplateTrigger): AgentTriggerShape {
  return {
    schedule: suggestion.schedule,
    listens: suggestion.triggers.map((trigger) => ({
      sourceKind: trigger.source.kind,
      eventTypes: trigger.eventTypes,
      conditions: (trigger.conditions ?? []) as readonly Condition[],
    })),
    repositories: [],
  };
}

/* ----------------------------------------------------------------------------
   The sentence.
   -------------------------------------------------------------------------- */

function conditionValue(conditions: readonly Condition[], field: string): string[] {
  const found = conditions.find(
    (condition) =>
      condition.field.trim() === field && (condition.op === "equals" || condition.op === "in"),
  );
  if (!found) return [];
  const value = found.value;
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" && found.op === "in"
      ? value.split(",")
      : [value];
  return values.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function listWords(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values[0]} or ${values.length - 1} more`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** What one event trigger listens for, with its repository and label. */
function listenWords(listen: AgentTriggerListen, context: AgentTriggerSentenceContext): string {
  const types = [...listen.eventTypes].sort();
  const has = (type: string) => types.includes(type);
  const repositories = conditionValue(listen.conditions, AGENT_TRIGGER_REPOSITORY_FIELD);
  const where = repositories.length > 0 ? ` in ${listWords(repositories)}` : "";
  const mentionsApp = listen.conditions.some(
    (condition) => condition.field.trim() === "data.comment.mentions_app",
  );
  if (types.length === 1 && has("issues.labeled")) {
    const labels = conditionValue(listen.conditions, "data.label");
    return labels.length > 0
      ? `an issue${where} gets the label ${listWords(labels)}`
      : `an issue${where} is labelled`;
  }
  if (types.length === 1 && has("issues.opened")) return `an issue opens${where}`;
  if (
    types.every(
      (type) => type === "pull_request.opened" || type === "pull_request.ready_for_review",
    )
  )
    return `a pull request opens${where}`;
  if (
    mentionsApp &&
    types.every(
      (type) => type === "issue_comment.created" || type === "pull_request_review_comment.created",
    )
  )
    return `someone mentions ${context.agentName} on a pull request${where}`;
  if (types.length === 1 && has("Issue.create")) return "a Linear issue is created";
  if (types.length === 1 && has("message.posted")) return "someone posts in a Slack channel";
  // The event catalog's own wording for anything else ("A chat stopped with an error").
  if (types.length === 1 && listen.sourceId && context.eventDescription) {
    const described = context.eventDescription(listen.sourceId, types[0]!)?.trim();
    if (described) return `${lowerFirst(described.replace(/\.$/u, ""))}${where}`;
  }
  return listen.sourceName
    ? `an event arrives from ${listen.sourceName}${where}`
    : `an event arrives${where}`;
}

export interface AgentTriggerSentenceContext {
  agentName: string;
  now: Date;
  /** The catalog's description of an event type on a source, once read. */
  eventDescription?: ((sourceId: string, eventType: string) => string | undefined) | undefined;
}

/** "Every Monday at 09:00 Oslo time": the schedule's sentence without "Runs". */
export function agentTriggerScheduleWords(
  t: OpenGeniText,
  schedule: ScheduledTaskScheduleSpec | AgentTemplateTrigger["schedule"],
  now: Date,
): string | null {
  if (!schedule || schedule.type === "manual") return null;
  // A ready-made agent's schedule has no time zone until it is added: say it in the viewer's.
  const spec = (
    schedule.type === "calendar" && !("timeZone" in schedule && schedule.timeZone)
      ? { ...schedule, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }
      : schedule
  ) as ScheduledTaskScheduleSpec;
  const words = automationScheduleWords(t, spec, now).sentence;
  const bare = words.replace(/^Runs /u, "").replace(/\.$/u, "");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/**
 * One trigger as a sentence: "When an issue in acme/api gets the label bug",
 * "When someone mentions Bug fixer on a pull request", "Every Monday at
 * 09:00 Oslo time, on acme/api". Never a raw event name.
 */
export function agentTriggerSentence(
  t: OpenGeniText,
  shape: AgentTriggerShape,
  context: AgentTriggerSentenceContext,
): string {
  const schedule = agentTriggerScheduleWords(t, shape.schedule, context.now);
  const on = shape.repositories.length > 0 ? `, on ${listWords(shape.repositories)}` : "";
  if (shape.listens.length === 0) return `${schedule ?? "When someone starts it"}${on}`;
  const events = [...new Set(shape.listens.map((listen) => listenWords(listen, context)))];
  const when = `When ${events.length > 2 ? `${events[0]} or ${events.length - 1} more` : events.join(" or ")}`;
  return schedule ? `${when}, and ${lowerFirst(schedule)}${on}` : `${when}${on}`;
}

/** The raw events a trigger listens to, for its details: "issues.labeled from GitHub". */
export function agentTriggerDetails(shape: AgentTriggerShape): string | null {
  if (shape.listens.length === 0) return null;
  return shape.listens
    .map(
      (listen) =>
        `${listen.eventTypes.join(", ")}${listen.sourceName ? ` from ${listen.sourceName}` : ""}`,
    )
    .join("; ");
}

/* ----------------------------------------------------------------------------
   Runs as, and who may switch or remove it.
   -------------------------------------------------------------------------- */

/**
 * Whose access a trigger's runs use: "Runs as you", "Runs as Ada Berg". A
 * workspace trigger with no owner runs as the workspace.
 */
export function agentTriggerRunsAs(
  task: Pick<ScheduledTask, "ownerSubjectId" | "createdBy">,
  viewerSubjectId: string,
  nameOf: (subjectId: string) => string | null = () => null,
): string {
  const owner = task.ownerSubjectId;
  if (owner == null) return "Runs as the workspace";
  if (owner === viewerSubjectId) return "Runs as you";
  const named =
    nameOf(owner) ??
    (task.createdBy?.subjectId === owner ? task.createdBy?.label?.trim() || null : null);
  return `Runs as ${named || "its owner"}`;
}

export interface AgentTriggerViewer {
  subjectId: string;
  /** `scheduled_tasks:manage` in the workspace. */
  canManage: boolean;
  /** `workspace:admin`: may turn someone else's shared trigger off and on. */
  isAdmin: boolean;
}

/**
 * What this viewer may do with one trigger, as the server allows it: its
 * owner switches and removes it; an admin may switch someone else's shared
 * one but never removes it. Anyone else sees the switch without changing it.
 */
export function agentTriggerAccess(
  task: Pick<ScheduledTask, "ownerSubjectId" | "visibility" | "creatorLocked">,
  viewer: AgentTriggerViewer,
): { canToggle: boolean; canRemove: boolean; reason: string | null } {
  const own = task.ownerSubjectId == null || task.ownerSubjectId === viewer.subjectId;
  const canToggle =
    viewer.canManage &&
    (own
      ? task.creatorLocked !== true || viewer.isAdmin
      : viewer.isAdmin && task.visibility !== "private");
  const canRemove = own && viewer.canManage && task.creatorLocked !== true;
  return {
    canToggle,
    canRemove,
    reason: canToggle
      ? null
      : "Only whoever added it, or a workspace admin, can turn it off and on.",
  };
}

/* ----------------------------------------------------------------------------
   Add trigger: outcomes first.
   -------------------------------------------------------------------------- */

export const AGENT_TRIGGER_OUTCOMES = [
  "issue_labelled",
  "pull_request_opens",
  "schedule",
  "mentioned",
] as const;
export type AgentTriggerOutcome = (typeof AGENT_TRIGGER_OUTCOMES)[number];

/** What each outcome card says, and whether it listens on GitHub. */
export function agentTriggerOutcomeCards(agentName: string): {
  value: AgentTriggerOutcome;
  title: string;
  description: string;
  github: boolean;
}[] {
  return [
    {
      value: "issue_labelled",
      title: "An issue gets a label",
      description: "For example bug, in the repositories you choose.",
      github: true,
    },
    {
      value: "pull_request_opens",
      title: "A pull request opens",
      description: "In the repositories you choose.",
      github: true,
    },
    {
      value: "schedule",
      title: "On a schedule",
      description: "Every day, week or month.",
      github: false,
    },
    {
      value: "mentioned",
      title: "Someone mentions it",
      description: `A comment on a pull request that says “${agentName}”.`,
      github: true,
    },
  ];
}

/** The label an "issue gets a label" trigger waits for, before one is typed. */
export const AGENT_TRIGGER_DEFAULT_LABEL = "bug";

/**
 * The suggestion an event outcome stands for, so it saves like any suggested
 * trigger (its GitHub source added when needed). Null for a schedule.
 */
export function agentTriggerOutcomeSuggestion(
  outcome: AgentTriggerOutcome,
  options: { agentName: string; label?: string | undefined },
): AgentTemplateTrigger | null {
  if (outcome === "schedule") return null;
  const common = commonAgentTriggers({ agentName: options.agentName });
  if (outcome === "pull_request_opens")
    return common.find((entry) => entry.key === "pull_request_opened")!.trigger;
  if (outcome === "mentioned")
    return common.find((entry) => entry.key === "mentioned_on_pull_request")!.trigger;
  const label = options.label?.trim() || AGENT_TRIGGER_DEFAULT_LABEL;
  return AgentTemplateTriggerSchema.parse({
    name: `When an issue gets the label ${label}`,
    instructions: `An issue got the label ${label}. Handle it.`,
    triggers: [
      {
        source: { kind: "github" },
        eventTypes: ["issues.labeled"],
        conditions: [{ field: "data.label", op: "equals", value: label }],
      },
    ],
  });
}

/**
 * The sentence that confirms a trigger before it is added: what starts the
 * agent, who can start it, and whose access its runs use.
 */
export function agentTriggerConfirmation(input: {
  agentName: string;
  /** The trigger's sentence, "When a pull request opens in acme/api". */
  sentence: string;
  outcome: AgentTriggerOutcome | "other";
}): { headline: string; detail: string } {
  const starts = `${input.agentName} starts ${lowerFirst(input.sentence)}.`;
  const who: Record<AgentTriggerOutcome | "other", string> = {
    issue_labelled: "Anyone who can label issues there can start it.",
    pull_request_opens: "Anyone who can open a pull request there can start it.",
    mentioned: "Members and collaborators who mention it can start it.",
    schedule: "Only the schedule starts it.",
    other: "Anything that sends these events can start it.",
  };
  const access =
    input.outcome === "schedule" || input.outcome === "other"
      ? "It runs as you and uses your access."
      : "It runs as you and uses your GitHub access.";
  return { headline: starts, detail: `${who[input.outcome]} ${access}` };
}
