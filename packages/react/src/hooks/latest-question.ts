import { SESSION_EVENT_TYPES, type SessionEvent, type SessionTurn } from "@opengeni/sdk";
import type { EmbeddedSessionClientLike } from "../client";
import {
  isTimelineUserQuestion,
  isTurnExecutionEvidence,
  timelineQuestionPlacement,
} from "../timeline/projection";

export type LatestQuestionOptions = {
  /** Check navigation.isCurrent() after awaits and immediately before UI effects. */
  onQueuedQuestion?: (
    turn: SessionTurn,
    navigation: { isCurrent: () => boolean },
  ) => void | Promise<void>;
};

/** Include every canonical execution fallback, not just turn.started. Derive
 * this optional navigation index only when the user requests Latest question. */
export const TIMELINE_TURN_ANCHOR_EVENT_TYPES = SESSION_EVENT_TYPES.filter(
  (type) =>
    isTurnExecutionEvidence(type) ||
    type === "turn.queued" ||
    type === "turn.started" ||
    type === "turn.cancelled" ||
    type === "session.queue.changed" ||
    type === "session.control.steer_requested",
);

/** Resolve an optional navigation destination without owning the hook's window
 * or React state. The caller guards errors and applies only a current result. */
export async function resolveLatestQuestion({
  client,
  workspaceId,
  sessionId,
  isCurrent,
  resumeSequence,
  options,
}: {
  client: EmbeddedSessionClientLike;
  workspaceId: string;
  sessionId: string;
  isCurrent: () => boolean;
  resumeSequence: (events: readonly SessionEvent[]) => number;
  options?: LatestQuestionOptions | undefined;
}): Promise<{ questionSequence: number; anchor: number; events: SessionEvent[] } | null> {
  let before: number | undefined;
  while (true) {
    const latest = await client.listEvents(workspaceId, sessionId, {
      direction: "before",
      includeTypes: ["user.message"],
      // Historical worker completions also used user.message; page only this
      // filtered index when they occupy the tail.
      limit: before === undefined ? 1 : 64,
      ...(before === undefined ? {} : { before }),
      payloadMode: "full",
      mode: "forensic",
    });
    if (!isCurrent()) return null;
    // Keep legacy childCompletion classification aligned with the transcript.
    const question = [...latest]
      .sort((a, b) => b.sequence - a.sequence)
      .find(isTimelineUserQuestion);
    if (question) {
      const queue = await client.getQueue(workspaceId, sessionId);
      if (!isCurrent()) return null;
      const pending = queue.items.find(
        (turn) => turn.triggerEventId === question.id && turn.metadata.delivery !== "steer",
      );
      if (pending) {
        if (!options?.onQueuedQuestion) {
          const reason = new Error("The latest question is in the prompt queue.");
          reason.name = "LatestQuestionQueuedError";
          throw reason;
        }
        await options.onQueuedQuestion(pending, { isCurrent });
        if (!isCurrent()) return null;
        // Queue refresh/focus can race a claim or withdrawal. Resolve that
        // transition below instead of settling on a row that just vanished.
        const refreshedQueue = await client.getQueue(workspaceId, sessionId);
        if (!isCurrent()) return null;
        if (
          refreshedQueue.items.some(
            (turn) => turn.triggerEventId === question.id && turn.metadata.delivery !== "steer",
          )
        )
          return null;
      }
      const evidence: SessionEvent[] = [];
      const payload =
        question.payload != null && typeof question.payload === "object"
          ? (question.payload as Record<string, unknown>)
          : {};
      // Explicit direct admission needs no lifecycle lookup. Older ledgers and
      // queued admission need their durable start/withdrawal witnesses.
      if (
        payload.routing !== "accepted_for_execution" &&
        payload.routing !== "accepted_for_steering" &&
        payload.delivery !== "steer"
      ) {
        let lifecycleAfter = question.sequence;
        while (true) {
          const page = await client.listEvents(workspaceId, sessionId, {
            direction: "after",
            after: lifecycleAfter,
            limit: 128,
            compact: true,
            mode: "forensic",
            payloadMode: "full",
            includeTypes: TIMELINE_TURN_ANCHOR_EVENT_TYPES,
          });
          if (!isCurrent()) return null;
          const next = Math.max(lifecycleAfter, resumeSequence(page));
          if (next === lifecycleAfter) break;
          const queued =
            page.find(
              (event) =>
                event.type === "turn.queued" &&
                ((event.payload ?? {}) as Record<string, unknown>).triggerEventId === question.id,
            ) ?? evidence.find((event) => event.type === "turn.queued");
          const turnId =
            queued && (((queued.payload ?? {}) as Record<string, unknown>).turnId ?? queued.turnId);
          evidence.push(
            ...page.filter((event) => {
              const data = (event.payload ?? {}) as Record<string, unknown>;
              return (
                data.triggerEventId === question.id ||
                (turnId != null &&
                  (event.turnId === turnId ||
                    data.turnId === turnId ||
                    data.targetTurnId === turnId))
              );
            }),
          );
          lifecycleAfter = next;
          const placed = timelineQuestionPlacement(question, evidence);
          if (placed.kind === "visible" && placed.sequence !== question.sequence) break;
        }
      }
      const placement = timelineQuestionPlacement(question, evidence);
      if (placement.kind === "withdrawn") {
        before = question.sequence;
        continue;
      }
      if (placement.kind === "pending")
        throw new Error("The latest question is changing queue state. Try again.");
      return {
        questionSequence: question.sequence,
        anchor: placement.sequence,
        events: [
          question,
          ...evidence.filter(
            (event) =>
              event.type === "turn.queued" &&
              ((event.payload ?? {}) as Record<string, unknown>).triggerEventId === question.id,
          ),
        ],
      };
    }
    const oldest = Math.min(...latest.map((event) => event.sequence));
    if (!Number.isSafeInteger(oldest) || oldest <= 1 || (before !== undefined && oldest >= before))
      return null;
    before = oldest;
  }
}
