import { listSessionEvents, type Database } from "@opengeni/db";
import type { TurnInitiator, TurnInitiatorContext } from "@opengeni/contracts";

type ReplyTurn = {
  source?: string | undefined;
  initiator: TurnInitiator;
  initiatorContext: TurnInitiatorContext;
};

/**
 * Provenance an agent adds when it creates a session or calls the API
 * (`via`, `viaTruncated`), plus internal-update and legacy markers: the prompt
 * came from an agent or a migration, not from a person.
 */
const DERIVED_PROVENANCE_KEYS = ["via", "viaTruncated", "provenanceError", "backfill"] as const;

/**
 * Worker-owned producers that create a session whose first turn (`source`
 * `user`) is their task prompt: scheduled runs, automations and site-auth
 * maintenance. An embedding host that asserts one of these service names only
 * gives up the recorded reply; it grants nothing.
 */
function isWorkerTaskProducer(initiator: TurnInitiator): boolean {
  if (initiator.kind !== "service") return false;
  const subjectId = initiator.subjectId;
  return (
    subjectId === "scheduler" ||
    subjectId === "site-auth-maintenance" ||
    subjectId.startsWith("automation:")
  );
}

/**
 * Whether a turn answers a message a person sent, directly or through an API
 * caller that relays one (an embedding host, a realtime delegation). The
 * source alone is not enough: every session's first turn is `user`, including
 * a child an agent spawned and a session a scheduled task created.
 */
export function turnAnswersMessage(turn: ReplyTurn): boolean {
  if (turn.source !== "user" && turn.source !== "api") return false;
  if (
    DERIVED_PROVENANCE_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(turn.initiatorContext, key),
    )
  ) {
    return false;
  }
  return !isWorkerTaskProducer(turn.initiator);
}

/**
 * The reply `turn.completed` records when a turn ends through `wait_for_input`
 * (read back with `turnCompletedReply` in `@opengeni/contracts`).
 *
 * Such a turn settles with an empty `output`: the wait, not an answer, ended
 * it. When the turn answers a person's message, the wait call's own `reply`
 * argument is that message's answer, exactly as the model wrote it. Without
 * one, its latest assistant message is still the answer, for example a status
 * reply given before waiting again on work in flight. That message shares its
 * model response with the wait call, so it streams as commentary, which is
 * activity everywhere else. Recording it lets unread attention and Slack treat
 * it as the answer without relabelling the provider's phase in stored history.
 * Turns that machine input, an agent or a worker-owned producer started only
 * narrate progress and record nothing.
 *
 * The message this activity completed last is the newest. An activity that
 * resumed the turn (after an approval, a human-input answer or a recovery) and
 * completed none reads the turn's latest durable message instead.
 */
export async function inputWaitReply(input: {
  inputWaitYielded: boolean;
  /** The accepted wait call's verbatim `reply` argument, if it had one. */
  waitReply?: string | null;
  turn: ReplyTurn;
  latestAssistantMessageText: string | null;
  readLatestDurableTurnMessage: () => Promise<string | null>;
}): Promise<string | null> {
  if (!input.inputWaitYielded || !turnAnswersMessage(input.turn)) return null;
  if (input.waitReply?.trim()) return input.waitReply;
  const text = input.latestAssistantMessageText ?? (await input.readLatestDurableTurnMessage());
  return text !== null && text.trim().length > 0 ? text : null;
}

/**
 * The agent message an accepted wait's `reply` argument becomes, or null.
 *
 * Text a model writes before a tool call can come back only as a summary
 * (Claude's progress updates), but a tool argument always arrives verbatim, so
 * the reply is shown as the turn's answer exactly as written, whoever started
 * the turn. It is not shown twice when the model also wrote the same text as
 * its latest message, or when it was already published once the wait was
 * accepted (the worker then records it as the latest message).
 */
export function inputWaitReplyMessage(input: {
  waitAccepted: boolean;
  waitReply: string | null;
  latestAssistantMessageText: string | null;
  /** The turn attempt (worker activity) that accepted the wait. */
  attemptId: string;
}): { text: string; messageId: string; phase: "final_answer" } | null {
  const reply = input.waitReply;
  if (!input.waitAccepted || reply === null || reply.trim().length === 0) return null;
  if (input.latestAssistantMessageText?.trim() === reply.trim()) return null;
  return {
    text: reply,
    messageId: `${WAIT_REPLY_MESSAGE_ID}:${input.attemptId}`,
    phase: "final_answer",
  };
}

/**
 * Message id prefix of the agent message carrying a wait's `reply`, followed by
 * the accepting attempt's id. An attempt keeps only its first accepted reply,
 * and the id keeps it a message of its own: it never merges into the turn's
 * earlier streamed text, nor into a reply a resumed attempt of the same turn
 * accepts after an approval.
 */
export const WAIT_REPLY_MESSAGE_ID = "wait_for_input:reply";

/** How far back to look past rejected-late or duplicate completions. */
const DURABLE_MESSAGE_LOOKBACK = 16;

/**
 * Text of the newest current `agent.message.completed` this turn persisted,
 * or null when the session's newest completion belongs to another turn.
 */
export async function latestDurableTurnMessageText(
  db: Database,
  input: { workspaceId: string; sessionId: string; turnId: string },
): Promise<string | null> {
  const events = await listSessionEvents(db, input.workspaceId, input.sessionId, {
    direction: "before",
    includeTypes: ["agent.message.completed"],
    limit: DURABLE_MESSAGE_LOOKBACK,
  });
  for (const event of events.reverse()) {
    if (event.duplicateOfEventId || (event.turnAssociation ?? "current") !== "current") continue;
    if (event.turnId !== input.turnId) return null;
    const text = (event.payload as { text?: unknown } | null)?.text;
    return typeof text === "string" ? text : null;
  }
  return null;
}

/**
 * Tool error the model receives when it waits before answering a person.
 *
 * Models with extended thinking often draft the reply inside their thinking
 * and believe it was sent, then retry the wait unchanged and conclude that a
 * wait cannot be armed at all. The text therefore names thinking explicitly and
 * points at the call's own `reply` argument, which is always shown verbatim.
 * Claude's progress update before a tool call is named too: only Anthropic's
 * summary of it comes back, as reasoning, so it is never shown or recorded as
 * the reply.
 */
export const INPUT_WAIT_REPLY_REFUSAL =
  "wait_for_input was not registered: this turn answers a person's message and you have not written a visible reply yet. Your reasoning is not shown to them: text inside a thinking or reasoning block does not count, even when it is written as an answer, and neither does a note written before a tool call (they may see only a short summary of it, as reasoning). Call wait_for_input again with your complete answer to their message in its `reply` argument; it is shown to them exactly as written. If an earlier wait is still armed, pass the time remaining on its deadline rather than a fresh timeout.";

/**
 * Tool error when the response that asked to wait holds a Claude progress
 * update and the call carries no `reply`: what the model wrote for the person
 * before the call reached them only as Anthropic's summary, as reasoning, even
 * if a short text block sits beside it.
 */
export const INPUT_WAIT_PROGRESS_UPDATE_REFUSAL =
  "wait_for_input was not registered: the note you wrote before this call reached the person only as a short summary, not as you wrote it, so they have not seen your answer. Call wait_for_input again with your complete answer to their message in its `reply` argument; it is shown to them exactly as written, so do not write it again before the call. If an earlier wait is still armed, pass the time remaining on its deadline rather than a fresh timeout.";

/**
 * Refusals per turn attempt (one worker activity); a resumed or retried
 * attempt starts again. After that the wait proceeds rather than looping.
 */
export const MAX_INPUT_WAIT_REPLY_REFUSALS = 2;

/**
 * Why `wait_for_input` must not end this turn yet, or null.
 *
 * A wait ends the turn at the tool boundary, so no message can follow it. A
 * call that carries its own `reply` always proceeds: that text is the answer.
 * Otherwise, when the turn answers a person's message, the wait is refused if
 * the response asking for it holds a Claude progress update (the model's note
 * for the person came back only as a summary) or if the turn has no visible
 * assistant text at all (the model may have drafted its answer only in its
 * reasoning). Refusing the wait as a tool error gives the model one more step
 * to pass its reply; the wait is registered on its next call.
 */
export async function inputWaitReplyRefusal(input: {
  turn: ReplyTurn;
  refusalsSoFar: number;
  /** The call's verbatim `reply` argument, if any. */
  reply?: string | null;
  hasVisibleReply: () => Promise<boolean>;
  /** Whether the response that asked to wait holds a Claude progress update. */
  hasProgressUpdate?: () => boolean;
}): Promise<string | null> {
  if (input.reply?.trim()) return null;
  if (input.refusalsSoFar >= MAX_INPUT_WAIT_REPLY_REFUSALS) return null;
  if (!turnAnswersMessage(input.turn)) return null;
  if (input.hasProgressUpdate?.()) return INPUT_WAIT_PROGRESS_UPDATE_REFUSAL;
  return (await input.hasVisibleReply()) ? null : INPUT_WAIT_REPLY_REFUSAL;
}
