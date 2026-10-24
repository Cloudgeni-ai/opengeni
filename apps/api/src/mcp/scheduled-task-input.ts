import {
  CreateScheduledTaskRequest,
  EVENT_TRIGGERS_PER_AUTOMATION_MAX,
  EventTriggerInput,
  ScheduledTaskEventsInput,
  ScheduledTaskAgentConfigInput,
  ScheduledTaskRunMode,
  ScheduledTaskScheduleSpec,
} from "@opengeni/contracts";
import { z } from "zod/v4";

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
    throw new Error(
      "Choose an existing chat or explicitly select reusable_session or new_session_per_run for a separate agent",
    );
  if (runMode === "existing_session" && !targetSessionId)
    throw new Error("Choose the chat that should receive scheduled messages");
  if (input.schedule === undefined && !hasEventTriggers(input))
    throw new Error("Add a schedule, or event triggers for an automation that runs on events");
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
        "An event source from event_sources_list.",
      ),
      eventTypes: EventTriggerInput.shape.eventTypes.describe(
        "Event types the source offers (event_sources_list with its sourceId). An MCP source takes exactly one.",
      ),
      conditions: EventTriggerInput.shape.conditions.describe(
        "Optional filters; every one must hold. field is type, subject, summary, url, actor.kind, actor.name or data.<path>.",
      ),
      includeOwnEvents: EventTriggerInput.shape.includeOwnEvents.describe(
        "Also fire on events Opengeni's own bots made. Off by default, which prevents loops.",
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

export function scheduledTaskCreateToolInput(options: { events: boolean } = { events: false }) {
  return (
    z
      .object({
        ...CreateScheduledTaskRequest.options[1].out.shape,
        runMode: ScheduledTaskRunMode.optional().describe(
          "Omit to schedule a message in this chat. Choose reusable_session or new_session_per_run only when the user requests a separate agent.",
        ),
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
          .omit({ slackBotChannelId: true, toolPolicy: true })
          .strict()
          .optional()
          .describe(
            "Creation settings for a separate scheduled agent. For an existing chat, supply prompt instead.",
          ),
        ...(options.events
          ? {
              schedule: ScheduledTaskScheduleSpec.optional().describe(
                "When it runs on a clock. Omit when it runs only on events.",
              ),
              events: scheduledTaskEventsToolInput(),
            }
          : {}),
      })
      // Only a person pins connector accounts; agents never do.
      // Variable Sets were removed (RM-1); agents choose vaults via vaultPolicy.
      .omit({
        agentLearning: true,
        connectionAuthorities: true,
        pinnedAccounts: true,
        pinnedAccountsRequired: true,
        variableSetId: true,
        environmentId: true,
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
