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
function turnAnswersMessage(turn: ReplyTurn): boolean {
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
 * it. When the turn answers a person's message, its latest assistant message
 * is still that message's answer, for example a status reply given before
 * waiting again on work in flight. That message shares its model response with
 * the wait call, so it streams as commentary, which is activity everywhere
 * else. Recording it lets unread attention and Slack treat it as the answer
 * without relabelling the provider's phase in stored history. Turns that
 * machine input, an agent or a worker-owned producer started only narrate
 * progress and record nothing.
 *
 * The message this activity completed last is the newest. An activity that
 * resumed the turn (after an approval, a human-input answer or a recovery) and
 * completed none reads the turn's latest durable message instead.
 */
export async function inputWaitReply(input: {
  inputWaitYielded: boolean;
  turn: ReplyTurn;
  latestAssistantMessageText: string | null;
  readLatestDurableTurnMessage: () => Promise<string | null>;
}): Promise<string | null> {
  if (!input.inputWaitYielded || !turnAnswersMessage(input.turn)) return null;
  const text = input.latestAssistantMessageText ?? (await input.readLatestDurableTurnMessage());
  return text !== null && text.trim().length > 0 ? text : null;
}

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
