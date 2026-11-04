import type { OpenGeniText } from "@opengeni/react/messages";

/** What the composer's single trailing control does right now. */
export type ComposerTrailingMode = "send" | "pause" | "resume" | "call" | "idle";

/**
 * Send wins whenever there is something to send (a message to a running agent
 * joins the queue); otherwise resume a paused workstream or pause a running
 * one; an otherwise empty composer offers a call when the host has one, and
 * else shows a quiet, disabled send.
 */
export function composerTrailingMode(input: {
  value: string;
  canSend: boolean;
  paused?: boolean | undefined;
  running?: boolean | undefined;
  canResume: boolean;
  canPause: boolean;
  canCall: boolean;
}): ComposerTrailingMode {
  if (input.value.trim().length > 0 || input.canSend) return "send";
  if (input.paused && input.canResume) return "resume";
  if (input.running && input.canPause) return "pause";
  return input.canCall ? "call" : "idle";
}

/**
 * The other send choice beside Send while the agent works: Queue when Send
 * steers, Steer when Send queues. Offered exactly while Send takes its busy
 * path (`alternateSend` from the composer), when the trailing action is Send
 * and the host can deliver it.
 */
export function composerAlternateSend(input: {
  trailing: ComposerTrailingMode;
  alternateSend?: "queue" | "steer" | null | undefined;
  available: boolean;
}): "queue" | "steer" | null {
  if (!input.available || input.trailing !== "send") return null;
  return input.alternateSend ?? null;
}

/**
 * One calm status across startup phases; hosts may supply their own wording.
 */
export function nativeLoadingPhrases(
  t: OpenGeniText,
  hostPhrases: readonly string[],
  _phase: "preparing" | "waiting",
): readonly string[] {
  if (hostPhrases.length > 0) return hostPhrases;
  return [t("native.timeline.messages.working")];
}
