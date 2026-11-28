/**
 * The inline "Add trigger" flow on an agent's page (docs/agents.md, Starts
 * when): the kinds of trigger it offers, what each starts from, which source
 * it still needs, and the automation it saves as. A trigger is an ordinary
 * automation whose runs are new chats with the agent. Pure;
 * `AgentTriggerDialog` renders it.
 */
import type {
  Agent,
  AgentTemplateTrigger,
  AutomationTemplateEventSource,
  CreateEventSourceRequest,
  CreateScheduledTaskRequest,
  EventSource,
  ResourceRef,
  ScheduledTask,
  ScheduledTaskEventsInput,
  ScheduledTaskScheduleSpec,
} from "@opengeni/sdk";
import {
  commonAgentTriggers,
  type AgentToolPermissionRuleInput,
  type CommonAgentTrigger,
} from "@opengeni/contracts";

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
  automationTemplateSourceChoice,
  eventSourceFitsTemplate,
  withTemplateSources,
} from "../../../components/automations/automation-template-model";
import {
  createEventSourceRequest,
  eventSourceChoiceOf,
  eventSourceStatusBadge,
  isAppWebhookChoice,
  eventSourceSubjectOfChoice,
  type EventSourceChoice,
  type EventSourceChoiceMeta,
} from "../../../components/automations/event-source-model";
import type { EventSourceLogoSubject } from "../../../components/automations/event-source-tile";
import {
  emptyEventTriggersDraft,
  newEventConditionDraft,
  newEventTriggerDraft,
  type EventTriggerDraft,
  type EventTriggersDraft,
} from "../../../components/automations/event-trigger-model";
import type { OpenGeniText } from "../../../messages/runtime";
import { apiErrorFacts, serverRefusalText, userErrorText } from "../../../ui/api-error";

/**
 * What a run says when the person adds no note: the event (which every event
 * run carries) and the agent's Instructions do the work.
 */
export const AGENT_TRIGGER_EVENT_MESSAGE = "Handle this event.";
export const AGENT_TRIGGER_SCHEDULE_MESSAGE = "Do your scheduled work.";

/** A refused shared trigger, in words. */
export const AGENT_TRIGGER_SHARED_DENIED =
  "You can't add automations shared with this workspace. Ask an admin for access.";

/**
 * A trigger offered on an agent before it is set up: one its ready-made
 * template suggests (`templateIndex`), or a common one (`common`).
 */
export interface AgentTriggerOffer {
  key: string;
  suggestion: AgentTemplateTrigger;
  templateIndex?: number | undefined;
  common?: CommonAgentTrigger["key"] | undefined;
}

/** Whether the agent uses GitHub: the workspace has it, and its Can use doesn't block all of it. */
export function agentUsesGitHub(
  rules: readonly AgentToolPermissionRuleInput[],
  githubConnected: boolean | null,
): boolean {
  if (githubConnected === false) return false;
  return !rules.some(
    (rule) =>
      rule.connector.trim().toLowerCase() === "github.com" &&
      (rule.tool ?? "*").trim() === "*" &&
      rule.permission === "block",
  );
}

/** The common triggers an agent can use, in offer order; its name narrows mentions to it. */
export function availableCommonTriggers(options: {
  usesGitHub: boolean;
  agentName?: string | undefined;
}): CommonAgentTrigger[] {
  return commonAgentTriggers({ agentName: options.agentName }).filter(
    (common) => common.needs === null || (common.needs === "github" && options.usesGitHub),
  );
}

type SignatureTrigger = {
  eventTypes: readonly string[];
  conditions?: readonly { field: string; op: string; value?: unknown }[] | undefined;
};
type SignatureSchedule =
  | { type: string; hour?: number; minute?: number; daysOfWeek?: readonly string[] }
  | null
  | undefined;

/**
 * What a trigger listens to: its events, the name a mention must say, and a
 * calendar's days and time. A renamed agent's old mention trigger no longer
 * matches, so the page offers the one for its new name.
 */
function listenSignature(
  triggers: readonly SignatureTrigger[],
  schedule: SignatureSchedule,
): string {
  if (triggers.length > 0) {
    return triggers
      .map((trigger) => {
        const named = (trigger.conditions ?? [])
          .filter((c) => c.field === "data.comment.body" && c.op === "contains")
          .map((c) =>
            String(c.value ?? "")
              .trim()
              .toLowerCase(),
          )
          .sort();
        return [[...trigger.eventTypes].sort().join(","), ...named].join("~");
      })
      .sort()
      .join("|");
  }
  if (!schedule || schedule.type === "manual") return "";
  if (schedule.type === "calendar") {
    return `calendar:${schedule.hour ?? ""}:${schedule.minute ?? ""}:${[...(schedule.daysOfWeek ?? [])].sort().join(",")}`;
  }
  return "schedule";
}

function eventSignature(suggestion: Pick<AgentTemplateTrigger, "schedule" | "triggers">): string {
  return listenSignature(suggestion.triggers, suggestion.schedule as SignatureSchedule);
}

/**
 * What an agent's page offers to turn on: its template's suggestions, then
 * each common trigger the template doesn't already suggest (by event types).
 * One the agent already has (its automation keeps the suggestion's name
 * after the agent's) is not offered again.
 */
/** What an automation listens to, compared the way offers are. */
function taskSignature(task: Pick<ScheduledTask, "schedule" | "events">): string {
  return listenSignature(
    (task.events?.triggers ?? []) as readonly SignatureTrigger[],
    task.schedule as SignatureSchedule,
  );
}

export function agentTriggerOffers(input: {
  templateSuggestions: readonly AgentTemplateTrigger[];
  /**
   * Made from a ready-made agent: its template's suggestions fit its job, so
   * common triggers (a PR opening, a PR mention) aren't added to them.
   */
  fromTemplate?: boolean | undefined;
  usesGitHub: boolean;
  agentName?: string | undefined;
  /** The agent's automations; null while they load. */
  tasks: readonly Pick<ScheduledTask, "name" | "schedule" | "events">[] | null;
}): AgentTriggerOffer[] {
  const fromTemplate: AgentTriggerOffer[] = input.templateSuggestions.map((suggestion, index) => ({
    key: `template-${index}`,
    suggestion,
    templateIndex: index,
  }));
  // A common trigger the template already suggests in its own form (by event types).
  const eventTypes = (suggestion: Pick<AgentTemplateTrigger, "schedule" | "triggers">) =>
    suggestion.triggers.length === 0
      ? suggestion.schedule
        ? "schedule"
        : ""
      : suggestion.triggers
          .flatMap((trigger) => trigger.eventTypes)
          .sort()
          .join(",");
  const covered = new Set(
    fromTemplate.map((offer) => eventTypes(offer.suggestion)).filter((s) => s !== ""),
  );
  // A schedule isn't offered to every agent: Add trigger's "On a schedule"
  // sets one up, with its time and repository.
  const common: AgentTriggerOffer[] = (
    input.fromTemplate
      ? []
      : availableCommonTriggers({ usesGitHub: input.usesGitHub, agentName: input.agentName })
  )
    .filter((entry) => entry.trigger.schedule === null)
    .filter((entry) => !covered.has(eventTypes(entry.trigger)))
    .map((entry) => ({ key: `common-${entry.key}`, suggestion: entry.trigger, common: entry.key }));
  return (
    [...fromTemplate, ...common]
      // Set up already: a template suggestion under its name, or anything
      // listening to the same thing.
      .filter(
        (offer) =>
          !input.tasks?.some(
            (task) =>
              (offer.common === undefined && task.name.endsWith(offer.suggestion.name)) ||
              (taskSignature(task) !== "" &&
                taskSignature(task) === eventSignature(offer.suggestion)),
          ),
      )
      .slice(0, AGENT_TRIGGER_OFFERS_MAX)
  );
}

/** How people start an agent from a pull request comment. */
export function mentionHint(agentName: string, productName = "Opengeni"): string {
  return `A comment that mentions ${productName} and says “${agentName}”`;
}

/** Offers shown at once, so the section stays to its essentials. */
export const AGENT_TRIGGER_OFFERS_MAX = 3;

/** The event field a GitHub trigger's repositories are chosen by. */
export const AGENT_TRIGGER_REPOSITORY_FIELD = "data.repository.full_name";

/** At most this many chosen repositories, the size of a condition's list. */
export const AGENT_TRIGGER_REPOSITORIES_MAX = 50;
/** A continued chat opens every chosen repository, so it takes fewer. */
export const AGENT_TRIGGER_CHAT_REPOSITORIES_MAX = 5;

/**
 * GitHub triggers narrowed to the chosen repositories (`owner/name`). None
 * chosen covers every repository the GitHub connection reaches. A new chat
 * per run checks out the repository its event is about, so the task keeps
 * none; a continued chat keeps the chosen ones as the task's (the dialog).
 */
export function agentTriggerRepositoryEvents(
  events: EventTriggersDraft,
  isGitHub: (trigger: EventTriggerDraft) => boolean,
  repositories: readonly string[],
): EventTriggersDraft {
  const chosen = [...new Set(repositories)].slice(0, AGENT_TRIGGER_REPOSITORIES_MAX);
  if (chosen.length === 0) return events;
  return {
    ...events,
    triggers: events.triggers.map((trigger) => {
      if (!isGitHub(trigger)) return trigger;
      const condition = {
        ...newEventConditionDraft(AGENT_TRIGGER_REPOSITORY_FIELD),
        ...(chosen.length === 1
          ? { op: "equals" as const, value: chosen[0]! }
          : { op: "in" as const, value: chosen.join(", ") }),
      };
      return {
        ...trigger,
        conditions: [
          ...trigger.conditions.filter(
            (existing) => existing.field.trim() !== AGENT_TRIGGER_REPOSITORY_FIELD,
          ),
          condition,
        ],
      };
    }),
  };
}

const NAME_MAX_LENGTH = 200;

/**
 * What starts the agent: a schedule, one of the person's event sources (or a
 * ready one they can use without adding), or a kind of source they don't
 * have yet.
 */
export type AgentTriggerPick =
  | { kind: "schedule" }
  | { kind: "source"; sourceId: string }
  | { kind: "new"; choice: EventSourceChoice };

/**
 * What a new kind of source takes before its events can start the agent:
 * Opengeni adds a GitHub, Slack or This workspace source right here
 * (`create`), a webhook is created here and shows its URL (`create_webhook`),
 * a Linear, Sentry or Tailscale webhook is created here, shows its URL and
 * takes the secret that app shows (`create_pasted`), GitHub first needs
 * connecting to the workspace (`connect_github`), and any other kind (a
 * connection or server to pick, or a kind this client doesn't know) is added
 * on the Add a source page (`add_source`).
 */
export type AgentTriggerSetup =
  | "create"
  | "create_webhook"
  | "create_pasted"
  | "connect_github"
  | "add_source";

export interface AgentTriggerOption {
  key: string;
  pick: AgentTriggerPick;
  label: string;
  /** For its logo tile; none for a schedule. */
  subject?: EventSourceLogoSubject | undefined;
  /** For a kind not added yet: what adding it takes. */
  setup?: AgentTriggerSetup | undefined;
  /**
   * A source that is off or needs attention: shown so its kind isn't offered
   * again as new, but it can't be picked. Says why.
   */
  unavailable?: string | undefined;
}

export function agentTriggerPickKey(pick: AgentTriggerPick): string {
  if (pick.kind === "schedule") return "schedule";
  return pick.kind === "source" ? `source:${pick.sourceId}` : `new:${pick.choice}`;
}

/** `githubConnected`: null when unknown, so the server decides when the source is added. */
export function agentTriggerNewSetup(
  choice: EventSourceChoice,
  options: { githubConnected: boolean | null },
): AgentTriggerSetup {
  if (choice === "github") return options.githubConnected === false ? "connect_github" : "create";
  if (choice === "slack" || choice === "workspace") return "create";
  if (choice === "webhook") return "create_webhook";
  if (isAppWebhookChoice(choice)) return "create_pasted";
  return "add_source";
}

/**
 * Everything that can start the agent, from the catalog "Add a source"
 * offers: a schedule, then each of the person's sources, then each kind they
 * can still add. A kind they already have is offered once, as their source;
 * webhooks, app webhooks and MCP servers can be added again. A source that is
 * off or blocked shows as unavailable, with why, rather than hiding its kind.
 * Nothing here names a kind, so a kind added to the catalog, or a source of
 * a kind this client doesn't know, shows up without changes.
 */
export function agentTriggerOptions(
  t: OpenGeniText,
  input: {
    choices: readonly EventSourceChoiceMeta[];
    sources: readonly EventSource[] | undefined;
    eventTriggers: boolean;
    githubConnected: boolean | null;
  },
): AgentTriggerOption[] {
  const schedule: AgentTriggerOption = {
    key: "schedule",
    pick: { kind: "schedule" },
    label: "Schedule",
  };
  if (!input.eventTriggers) return [schedule];
  const sources = input.sources ?? [];
  const have = new Set(sources.map((source) => eventSourceChoiceOf(source)));
  // Active sources first; an inactive one still stands for its kind.
  const existing = [...sources]
    .sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active"))
    .map((source): AgentTriggerOption => {
      const option: AgentTriggerOption = {
        key: agentTriggerPickKey({ kind: "source", sourceId: source.id }),
        pick: { kind: "source", sourceId: source.id },
        label: source.name,
        subject: source,
      };
      // A webhook waiting for its app's secret can be picked by whoever may
      // set it: the secret is pasted here.
      if (source.status === "active" || agentTriggerCanPasteSecret(source)) return option;
      const badge = eventSourceStatusBadge(t, source);
      if (agentTriggerAwaitsSecret(source) && source.viewerAccess === "use")
        return { ...option, unavailable: "Its owner pastes the secret." };
      return {
        ...option,
        unavailable: badge?.reason ?? badge?.label ?? "Unavailable",
      };
    });
  const fresh = input.choices
    .filter((meta) => meta.setup === "paste" || meta.choice === "mcp" || !have.has(meta.choice))
    .map((meta): AgentTriggerOption => {
      const pick = { kind: "new", choice: meta.choice } as const;
      return {
        key: agentTriggerPickKey(pick),
        pick,
        label: meta.choice === "webhook" ? "Create a webhook" : meta.name,
        subject: eventSourceSubjectOfChoice(t, meta.choice),
        setup: agentTriggerNewSetup(meta.choice, {
          githubConnected: input.githubConnected,
        }),
      };
    });
  return [schedule, ...existing, ...fresh];
}

/**
 * The draft a pick starts: the default schedule, or one trigger on the
 * source whose events the person then picks. The note typed so far stays.
 */
export function agentTriggerDraftForPick(
  pick: AgentTriggerPick,
  options: { note?: string | undefined; timeZone?: string | undefined } = {},
): AutomationDraft {
  const note = options.note ?? "";
  if (pick.kind === "schedule") {
    return {
      ...newAutomationDraft({
        cadence: defaultAutomationCadence(options.timeZone),
      }),
      instructions: note,
    };
  }
  return {
    ...newAutomationDraft({ cadence: null }),
    instructions: note,
    events: {
      ...emptyEventTriggersDraft(),
      triggers: pick.kind === "source" ? [newEventTriggerDraft(pick.sourceId)] : [],
    },
  };
}

/** A suggested trigger's draft: its events, conditions, schedule and instructions. */
export function agentTriggerDraftFromSuggestion(
  suggestion: AgentTemplateTrigger,
  options: {
    sources?: readonly EventSource[] | undefined;
    timeZone?: string | undefined;
  } = {},
): AutomationDraft {
  return automationDraftFromTemplate(
    {
      id: "agent-trigger-suggestion",
      name: suggestion.name,
      description: suggestion.name,
      instructions: suggestion.instructions,
      schedule: suggestion.schedule,
      triggers: suggestion.triggers,
    },
    { sources: options.sources, timeZone: options.timeZone },
  );
}

/** Triggers still without a source take the person's own once sources load; the same draft when none changed. */
export function agentTriggerWithSources(
  events: AutomationDraft["events"],
  sources: readonly EventSource[] | undefined,
): AutomationDraft["events"] {
  return withTemplateSources(events, sources);
}

/** The message each run sends: the person's note, else a short default. */
export function agentTriggerMessage(draft: Pick<AutomationDraft, "instructions" | "events">) {
  const note = draft.instructions.trim();
  if (note) return note;
  return draft.events.triggers.length > 0
    ? AGENT_TRIGGER_EVENT_MESSAGE
    : AGENT_TRIGGER_SCHEDULE_MESSAGE;
}

/** The kind of source a trigger asks for while the person has none of it. */
export function agentTriggerMissingSource(
  draft: AutomationDraft,
  sources: readonly EventSource[] | undefined,
): AutomationTemplateEventSource | undefined {
  if (!sources) return undefined;
  for (const trigger of draft.events.triggers) {
    if (trigger.sourceId || !trigger.templateSource) continue;
    const wanted = trigger.templateSource;
    if (!sources.some((source) => eventSourceFitsTemplate(wanted, source))) return wanted;
  }
  return undefined;
}

/**
 * What a suggestion's missing source takes, as for a new kind; a webhook it
 * asks for is added on the Add a source page, since its sender needs the URL.
 */
export function agentTriggerSourceStep(
  wanted: AutomationTemplateEventSource,
  options: { githubConnected: boolean | null },
): AgentTriggerSetup {
  const setup = agentTriggerNewSetup(automationTemplateSourceChoice(wanted), options);
  return setup === "create_webhook" || setup === "create_pasted" ? "add_source" : setup;
}

/** A pasted webhook (Linear, Sentry, another app) whose secret isn't set yet. */
export function agentTriggerAwaitsSecret(
  source: Pick<EventSource, "kind" | "awaitingSigningSecret"> | undefined,
): boolean {
  return source?.kind === "webhook" && source.awaitingSigningSecret === true;
}

/**
 * Whether this person can paste the secret of a webhook that waits for it:
 * only while it is blocked for that reason (not turned off), and only for
 * whoever may change the source (its owner or an admin; a source they just
 * made has no access level yet and is theirs).
 */
export function agentTriggerCanPasteSecret(
  source:
    | Pick<
        EventSource,
        "kind" | "awaitingSigningSecret" | "status" | "statusReasonCode" | "viewerAccess"
      >
    | undefined,
): boolean {
  return (
    agentTriggerAwaitsSecret(source) &&
    source?.status === "blocked" &&
    source.statusReasonCode === "awaiting_secret" &&
    source.viewerAccess !== "use"
  );
}

/** Why a pasted secret can't be saved, or undefined when it can. */
export function agentTriggerSecretIssue(
  value: string,
  setup: { app: string; secretName: string },
): string | undefined {
  return value.trim().length < 8 ? `Paste the ${setup.secretName} ${setup.app} shows.` : undefined;
}

/**
 * Whether the draft can't be saved yet: no schedule and no event, or the
 * schedule or events as the full form checks them. A source Opengeni adds on
 * save isn't missing. The note never is: it has a default.
 */
export function agentTriggerIssues(
  t: OpenGeniText,
  draft: AutomationDraft,
  sources: readonly Pick<EventSource, "id" | "kind">[],
  now: Date,
): AutomationDraftIssues {
  const pending = draft.events.triggers.filter(
    (trigger) => !trigger.sourceId && trigger.templateSource,
  );
  const checked = {
    ...draft,
    instructions: agentTriggerMessage(draft),
    events: {
      ...draft.events,
      triggers: draft.events.triggers.filter((trigger) => !pending.includes(trigger)),
    },
  };
  const issues = validateAutomationDraft(t, checked, sources, now);
  if (!draft.cadence && draft.events.triggers.length === 0) issues.when = "Choose when it starts.";
  return issues;
}

/** A suggestion keeps its name after the agent's, so the agent page knows it is set up. */
export function agentTriggerName(
  t: OpenGeniText,
  agent: Pick<Agent, "name">,
  suggestion: Pick<AgentTemplateTrigger, "name"> | undefined,
  request: {
    schedule: ScheduledTaskScheduleSpec;
    events?: ScheduledTaskEventsInput | undefined;
  },
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
 * Where each run goes: a new chat with the agent (the default), one chat
 * the trigger keeps for all its runs, or an existing chat with the agent.
 */
export type AgentTriggerChat =
  | { mode: "new_session_per_run" }
  | { mode: "reusable_session" }
  | { mode: "existing_session"; sessionId: string };

export const AGENT_TRIGGER_NEW_CHAT: AgentTriggerChat = {
  mode: "new_session_per_run",
};

/** What the dialog says each run does, for the chat picked. */
export function agentTriggerChatWords(agent: Pick<Agent, "name">, chat: AgentTriggerChat): string {
  if (chat.mode === "reusable_session") return `Each run continues one chat with ${agent.name}`;
  if (chat.mode === "existing_session") return `Each run continues a chat with ${agent.name}`;
  return `Each run starts a new chat with ${agent.name}`;
}

/**
 * The automation a trigger saves as: runs in chats with the agent (a new one
 * each run unless another chat is picked), shared like the agent (an Only me
 * agent's trigger is Only me, any other is shared with the workspace), with
 * the repositories picked for it.
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
    chat?: AgentTriggerChat | undefined;
  },
): CreateScheduledTaskRequest {
  const base = automationCreateRequest(
    t,
    { ...input.draft, instructions: agentTriggerMessage(input.draft) },
    { kind: "new_chat" },
    input.now,
  );
  if (!("agentConfig" in base) || !base.agentConfig) return base;
  const chat = input.chat ?? AGENT_TRIGGER_NEW_CHAT;
  return {
    ...base,
    name: agentTriggerName(t, input.agent, input.suggestion, base, input.sources, input.now),
    visibility: input.agent.visibility === "private" ? "private" : "workspace",
    runMode: chat.mode,
    ...(chat.mode === "existing_session" ? { targetSessionId: chat.sessionId } : {}),
    agentConfig: {
      ...base.agentConfig,
      agentId: input.agent.id,
      resources: [...(input.resources ?? [])],
    },
  };
}

/** Why a save was refused, in words; a shared trigger the person may not add says so. */
/**
 * Why turning a trigger on failed: a ready-made agent missing a required
 * connection gets the server's reason in words ("Connect GitHub to turn this on.").
 */
export function agentTriggerOnError(error: unknown): string {
  return serverRefusalText(error, ["agent_setup_incomplete"]) ?? userErrorText(error);
}

export function agentTriggerSaveError(error: unknown, visibility: "private" | "workspace"): string {
  const setup = serverRefusalText(error, ["agent_setup_incomplete"]);
  if (setup) return setup;
  if (apiErrorFacts(error).status === 403 && visibility !== "private")
    return AGENT_TRIGGER_SHARED_DENIED;
  return userErrorText(error);
}

/**
 * Adds a one-click suggestion (`oneClick`) with no form: its GitHub triggers
 * listen on the person's GitHub source, added here when they have none and
 * GitHub is connected. Anything else it would need (connecting GitHub, a
 * webhook) returns `needs_setup`, and the page opens the dialog instead.
 */
export async function addAgentSuggestedTrigger(
  t: OpenGeniText,
  input: {
    client: {
      listEventSources(workspaceId: string): Promise<EventSource[]>;
      createEventSource(
        workspaceId: string,
        request: CreateEventSourceRequest,
      ): Promise<{ source: EventSource }>;
      createScheduledTask(
        workspaceId: string,
        request: CreateScheduledTaskRequest,
      ): Promise<ScheduledTask>;
    };
    workspaceId: string;
    agent: Pick<Agent, "id" | "name" | "visibility">;
    suggestion: AgentTemplateTrigger;
    githubConnected: boolean | null;
    timeZone?: string | undefined;
    now: Date;
  },
): Promise<{ kind: "created"; task: ScheduledTask } | { kind: "needs_setup" }> {
  const visibility = input.agent.visibility === "private" ? "private" : "workspace";
  let sources = await input.client.listEventSources(input.workspaceId);
  let draft = agentTriggerDraftFromSuggestion(input.suggestion, {
    sources,
    timeZone: input.timeZone,
  });
  const missing = agentTriggerMissingSource(draft, sources);
  if (missing) {
    // Unknown status leaves it to the server, as the dialog's source step does.
    if (missing.kind !== "github" || input.githubConnected === false)
      return { kind: "needs_setup" };
    const { source } = await input.client.createEventSource(
      input.workspaceId,
      createEventSourceRequest(t, {
        choice: automationTemplateSourceChoice(missing),
        name: "",
        visibility,
      }),
    );
    sources = [...sources, source];
    draft = {
      ...draft,
      events: {
        ...draft.events,
        triggers: draft.events.triggers.map((trigger) =>
          !trigger.sourceId && trigger.templateSource?.kind === "github"
            ? { ...trigger, sourceId: source.id }
            : trigger,
        ),
      },
    };
  }
  if (draft.events.triggers.some((trigger) => !trigger.sourceId)) return { kind: "needs_setup" };
  const task = await input.client.createScheduledTask(
    input.workspaceId,
    agentTriggerCreateRequest(t, {
      agent: input.agent,
      suggestion: input.suggestion,
      draft,
      sources,
      now: input.now,
    }),
  );
  return { kind: "created", task };
}
