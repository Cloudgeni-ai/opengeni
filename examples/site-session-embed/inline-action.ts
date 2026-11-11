import { createOpenGeniSiteClient, type OpenGeniSiteAiResult } from "@opengeni/sdk/site";

/** The product owns prompts, controls and result rendering; this module has no UI. */
export async function runInlineAction(input: {
  prompt: string;
  actionId: string;
  signal?: AbortSignal;
  rememberSession: (sessionId: string) => void;
  appendText?: (text: string) => void;
}): Promise<OpenGeniSiteAiResult> {
  return createOpenGeniSiteClient().ai.run(
    {
      initialMessage: input.prompt,
      idempotencyKey: input.actionId,
    },
    {
      signal: input.signal,
      onSession: input.rememberSession,
      onText: input.appendText,
    },
  );
}
