import {
  CreateScheduledTaskRequest,
  ScheduledTaskAgentConfigInput,
  ScheduledTaskRunMode,
} from "@opengeni/contracts";
import { z } from "zod/v4";

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
  return CreateScheduledTaskRequest.parse({
    ...input,
    runMode,
    ...(targetSessionId ? { targetSessionId } : {}),
  });
}

export function scheduledTaskCreateToolInput() {
  return z
    .object({
      ...CreateScheduledTaskRequest.options[1].out.shape,
      runMode: ScheduledTaskRunMode.optional().describe(
        "Omit to schedule a message in this chat. Choose reusable_session or new_session_per_run only when the user requests a separate agent.",
      ),
      targetSessionId: z
        .string()
        .uuid()
        .optional()
        .describe("Destination chat. Omitted existing-session destinations use the calling chat."),
      prompt: ScheduledTaskAgentConfigInput.shape.prompt
        .optional()
        .describe(
          "Message to send to an existing chat at each occurrence. The chat supplies its model, tools and machine.",
        ),
      agentConfig: z
        .object(ScheduledTaskAgentConfigInput.shape)
        .omit({ slackBotChannelId: true })
        .strict()
        .optional()
        .describe(
          "Creation settings for a separate scheduled agent. For an existing chat, supply prompt instead.",
        ),
    })
    .omit({ agentLearning: true, connectionAuthorities: true })
    .strict();
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
