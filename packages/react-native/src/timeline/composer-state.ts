import { GENIE_PREPARING_PHRASES, GENIE_WAITING_PHRASES } from "@opengeni/react/timeline-model";

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
 * The loading copy beside the orb: a host's own phrases replace both phases',
 * as the web timeline's loading `phrases` option does; otherwise the built-in
 * preparing or waiting copy.
 */
export function nativeLoadingPhrases(
  hostPhrases: readonly string[],
  phase: "preparing" | "waiting",
): readonly string[] {
  if (hostPhrases.length > 0) return hostPhrases;
  return phase === "waiting" ? GENIE_WAITING_PHRASES : GENIE_PREPARING_PHRASES;
}
