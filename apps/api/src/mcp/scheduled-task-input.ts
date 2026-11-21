import {
  CreateScheduledTaskRequest,
  EVENT_TRIGGERS_PER_AUTOMATION_MAX,
  EventTriggerInput,
  ScheduledTaskEventsInput,
  ScheduledTaskAgentConfigInput,
  ScheduledTaskOverlapPolicy,
  ScheduledTaskRunMode,
  ScheduledTaskScheduleSpec,
  UpdateScheduledTaskRequest,
} from "@opengeni/contracts";
import { z } from "zod/v4";
import { ToolArgumentError } from "./tool-argument-error";

const SCHEDULE_TIME_ZONE_DESCRIPTION =
  "IANA time zone the schedule's clock times are in, for example Europe/Oslo. Omit it to use the time zone of the message that asked for the schedule (an edited schedule keeps its current zone); UTC when there is none.";

const OVERLAP_POLICY_DESCRIPTION =
  "What a run does when the chat it continues is still busy. Runs in a new chat never wait, so this only matters for runs into a chat. steer (the default): when the busy turn is this automation's own earlier run, the new run reaches it at its next step, so the agent sees the new run together with the work so far; a turn anyone else started finishes first, then the run starts. buffer_one (allow_concurrent is the same in a chat): the run always waits and starts after the current turn. skip: the run is dropped.";

/** The overlap choice for agent tools, explained so its values can't be misread. */
export function scheduledTaskOverlapPolicyToolInput() {
  return ScheduledTaskOverlapPolicy.optional().describe(OVERLAP_POLICY_DESCRIPTION);
}

/**
 * The contract's schedule shapes for agent tools. The contract defaults an
 * omitted zone to UTC; for an agent the server fills it from the message that
 * asked for the schedule instead, so the tool schema describes that default.
 */
export function scheduledTaskScheduleToolInput() {
  const [manual, once, interval, calendar] = ScheduledTaskScheduleSpec.options;
  const timeZone = z.string().min(1).optional().describe(SCHEDULE_TIME_ZONE_DESCRIPTION);
  return z.discriminatedUnion("type", [
    manual,
    once.extend({ timeZone }),
    interval,
    calendar.extend({ timeZone }),
  ]);
}

/** An automation with event triggers and no schedule runs on events (and by hand) only. */
function hasEventTriggers(input: Record<string, unknown>): boolean {
  const events = input.events;
  return (
    typeof events === "object" &&
    events !== null &&
    Array.isArray((events as { triggers?: unknown }).triggers) &&
    (events as { triggers: unknown[] }).triggers.length > 0
  );
}

/** The calling session is supplied by the signed grant, never by model text. */
export function resolveScheduledTaskCreateInput(
  input: Record<string, unknown>,
  sessionId: string | null,
) {
  const runMode =
    input.runMode ?? (input.targetSessionId || sessionId ? "existing_session" : undefined);
  const targetSessionId =
    input.targetSessionId ?? (runMode === "existing_session" ? sessionId : undefined);
  if (!runMode)
    throw new ToolArgumentError(
      "Choose an existing chat or explicitly select reusable_session or new_session_per_run for a separate agent",
    );
  if (runMode === "existing_session" && !targetSessionId)
    throw new ToolArgumentError("Choose the chat that should receive scheduled messages");
  if (input.schedule === undefined && !hasEventTriggers(input))
    throw new ToolArgumentError(
      "Add a schedule, or event triggers for an automation that runs on events",
    );
  return CreateScheduledTaskRequest.parse({
    ...input,
    schedule: input.schedule ?? { type: "manual" },
    runMode,
    ...(targetSessionId ? { targetSessionId } : {}),
  });
}

/**
 * The `events` field of the create and update tools: the contract's own
 * schema, described for the model. Present only where event triggers run.
 */
export function scheduledTaskEventsToolInput() {
  const trigger = z
    .object({
      ...EventTriggerInput.shape,
      sourceId: EventTriggerInput.shape.sourceId.describe(
        "An event source's id, or a readyToAdd id, from event_sources_list.",
      ),
      eventTypes: EventTriggerInput.shape.eventTypes.describe(
        "Event types the source offers (event_sources_list with its sourceId). An MCP source takes exactly one.",
      ),
      conditions: EventTriggerInput.shape.conditions.describe(
        "Optional filters; every one must hold. field is type, subject, summary, url, actor.kind, actor.name or data.<path>. contains ignores case.",
      ),
      includeOwnEvents: EventTriggerInput.shape.includeOwnEvents.describe(
        "Also fire on events this deployment's own bots made. Off by default, which prevents loops.",
      ),
      arguments: EventTriggerInput.shape.arguments.describe(
        "MCP sources: subscription arguments that match the event type's argumentsSchema.",
      ),
    })
    .strict();
  return z
    .object({
      ...ScheduledTaskEventsInput.shape,
      triggers: z
        .array(trigger)
        .max(EVENT_TRIGGERS_PER_AUTOMATION_MAX)
        .describe(
          "Run when any trigger matches an event. On update, the list replaces all triggers.",
        ),
      once: ScheduledTaskEventsInput.shape.once.describe(
        "Finish after the first run, whichever trigger fires first. Use it for “wake me when…”.",
      ),
      maxRunsPerHour: ScheduledTaskEventsInput.shape.maxRunsPerHour.describe(
        "Event runs allowed in a rolling hour (default 30). Further events wait and arrive together in the next run.",
      ),
    })
    .strict()
    .optional()
    .describe(
      "Run when something happens in another app. Each run receives the events that caused it.",
    );
}

/**
 * Agent-config fields agents never set through the schedule tools: a person
 * chooses Slack posting and connector policy, and chat settings for an
 * automation (attached servers, memory, reach, inline Skills) are set by a
 * person or the app that manages it. An agent's schedule always keeps its own
 * chat's Opengeni tools and permissions.
 */
export const SCHEDULED_TASK_TOOL_OMITTED_AGENT_CONFIG = {
  slackBotChannelId: true,
  toolPolicy: true,
  mcpServers: true,
  memoryScope: true,
  agentAccess: true,
  skills: true,
  firstPartyMcpTools: true,
  firstPartyMcpPermissions: true,
} as const;

/**
 * The agent each run's chat is with, by name or id, as session_create's
 * agentName takes it. The tool resolves it to the contract's agentId before
 * the request is parsed, so the REST shape is unchanged.
 */
export function scheduledTaskAgentNameToolInput() {
  return z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Name or id of an agent in this workspace (for example "Triage"): each run\'s chat is with that agent, with its Instructions, Memory and Can use. Use instead of agentId.',
    );
}

export type ScheduledTaskAgentResolution =
  | { ok: true; agentId: string }
  | { ok: false; message: string };

/** Where a tool takes an agent by name: create's agentConfig, update's agentConfigPatch. */
export type ScheduledTaskAgentField = "agentConfig" | "agentConfigPatch";

/**
 * Why `agentName` named no agent the person this chat acts for
 * can use, or several, worded for scheduling. Null for any other refusal,
 * whose own message stands.
 */
export function scheduledTaskAgentNameRefusal(
  ref: string,
  refusal: { code: string; agentIds?: readonly string[] | undefined },
  field: ScheduledTaskAgentField = "agentConfig",
): string | null {
  const name = ref.trim();
  if (refusal.code === "agent_name_ambiguous") {
    return `More than one agent is named "${name}". Give ${field}.agentId instead, one of: ${(refusal.agentIds ?? []).join(", ")}.`;
  }
  if (refusal.code === "agent_not_found") {
    return field === "agentConfig"
      ? `No agent named "${name}" is available here to the person this chat acts for. Check the agent's name, or give agentConfig.agentId; leave out agentConfig.agentName to schedule without an agent.`
      : `No agent named "${name}" is available here to the person this chat acts for. Check the agent's name, or give agentConfigPatch.agentId; agentId null removes the agent.`;
  }
  return null;
}

/**
 * Replace `agentName` in `agentConfig` (or update's `agentConfigPatch`) with
 * the agentId it names. Input without one is returned as it is.
 */
export async function withResolvedScheduledTaskAgent(
  input: Record<string, unknown>,
  resolve: (ref: string) => Promise<ScheduledTaskAgentResolution>,
  field: ScheduledTaskAgentField = "agentConfig",
): Promise<Record<string, unknown>> {
  const agentConfig = input[field];
  if (typeof agentConfig !== "object" || agentConfig === null || Array.isArray(agentConfig))
    return input;
  const { agentName, ...rest } = agentConfig as Record<string, unknown>;
  if (agentName === undefined) return input;
  if (typeof agentName !== "string" || agentName.trim() === "")
    throw new ToolArgumentError(`${field}.agentName must name an agent`);
  if (rest.agentId !== undefined)
    throw new ToolArgumentError(`Give ${field}.agentName or ${field}.agentId, not both`);
  const resolved = await resolve(agentName);
  if (!resolved.ok) throw new ToolArgumentError(resolved.message);
  return { ...input, [field]: { ...rest, agentId: resolved.agentId } };
}

/**
 * Validates an update call against the contract as it will be sent: an
 * `agentConfigPatch.agentName` stands for the agentId it resolves to.
 */
export function scheduledTaskUpdateToolValidation() {
  return z.record(z.string(), z.unknown()).superRefine((input, context) => {
    const patch = input.agentConfigPatch;
    let candidate = input;
    if (typeof patch === "object" && patch !== null && !Array.isArray(patch)) {
      const { agentName, ...rest } = patch as Record<string, unknown>;
      if (agentName !== undefined) {
        if (typeof agentName !== "string" || agentName.trim() === "") {
          context.addIssue({
            code: "custom",
            path: ["agentConfigPatch", "agentName"],
            message: "agentConfigPatch.agentName must name an agent",
          });
          return;
        }
        if (rest.agentId !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["agentConfigPatch", "agentName"],
            message: "Give agentConfigPatch.agentName or agentConfigPatch.agentId, not both",
          });
          return;
        }
        // The name resolves to an id before the call is sent.
        candidate = { ...input, agentConfigPatch: { ...rest, agentId: NAMED_AGENT_PLACEHOLDER } };
      }
    }
    const parsed = UpdateScheduledTaskRequest.safeParse(candidate);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue });
  });
}

const NAMED_AGENT_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

export function scheduledTaskCreateToolInput(options: { events: boolean } = { events: false }) {
  return (
    z
      .object({
        ...CreateScheduledTaskRequest.options[1].out.shape,
        runMode: ScheduledTaskRunMode.optional().describe(
          "Omit to schedule a message in this chat. Choose reusable_session or new_session_per_run only when the user requests a separate agent.",
        ),
        overlapPolicy: scheduledTaskOverlapPolicyToolInput(),
        targetSessionId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Destination chat. Omitted existing-session destinations use the calling chat.",
          ),
        prompt: ScheduledTaskAgentConfigInput.shape.prompt
          .optional()
          .describe(
            "Message to send to an existing chat at each occurrence. The chat supplies its model, tools and machine.",
          ),
        agentConfig: z
          .object(ScheduledTaskAgentConfigInput.shape)
          .omit(SCHEDULED_TASK_TOOL_OMITTED_AGENT_CONFIG)
          .extend({ agentName: scheduledTaskAgentNameToolInput() })
          .strict()
          .optional()
          .describe(
            "Creation settings for a separate scheduled agent. For an existing chat, supply prompt instead.",
          ),
        ...(options.events
          ? {
              schedule: scheduledTaskScheduleToolInput()
                .optional()
                .describe("When it runs on a clock. Omit when it runs only on events."),
              events: scheduledTaskEventsToolInput(),
            }
          : { schedule: scheduledTaskScheduleToolInput() }),
      })
      // Only a person pins connector accounts; agents never do.
      .omit({
        agentLearning: true,
        connectionAuthorities: true,
        // Agents can't lock a schedule to themselves.
        creatorLocked: true,
        pinnedAccounts: true,
        pinnedAccountsRequired: true,
        ...(options.events ? {} : { events: true as const }),
      })
      .strict()
  );
}

// Validate the original call, before projection defaults can add fields from
// the separate-agent branch to the existing-chat message branch.
export function scheduledTaskCreateToolValidation(sessionId: string | null) {
  return z.record(z.string(), z.unknown()).superRefine((input, context) => {
    try {
      resolveScheduledTaskCreateInput(input, sessionId);
    } catch (error) {
      if (error instanceof z.ZodError)
        for (const issue of error.issues) context.addIssue({ ...issue });
      else
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Invalid schedule destination",
        });
    }
  });
}
