import type { SessionTurn } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ComposerOptimisticMessage, ComposerState } from "./use-composer";
import type { QueueMutationKind, UseTurnQueueResult } from "./use-turn-queue";

/** What one Up-arrow recall did. `unavailable` leaves the composer untouched. */
export type QueuedPromptRecallOutcome = "recalled" | "already_sent" | "unavailable";

/**
 * How long Up pressed right after a send waits for that prompt to reach the
 * queue. The send is normally settled within a second or two; past this the
 * press is dropped rather than left pending behind a stalled send.
 */
export const QUEUED_RECALL_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Up-arrow recall of the person's latest waiting prompt. `available` is a
 * render-time hint that Up should be taken for recall: a prompt is waiting, or
 * one just sent is still on its way into the queue. `recall` re-checks
 * everything against live state, waiting for such a send to settle first.
 */
export type ComposerQueuedRecall = {
  available: boolean;
  /** The waiting prompt Up would pull back now, for a subtle hint on its row. */
  turnId: string | null;
  recall: () => Promise<QueuedPromptRecallOutcome>;
};

/**
 * Plain Up in an empty composer (caret necessarily at the start), outside IME
 * composition and with no command/mention popup open. Any typed text, quote or
 * attachment keeps normal Up behaviour so recall never replaces a draft.
 */
export function shouldRecallQueuedOnKey(
  event: {
    key: string;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    keyCode?: number;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
  },
  field: {
    value: string;
    selectionStart: number | null;
    selectionEnd: number | null;
    /** Attachments, quotes or restored files already in the draft. */
    hasOtherContent: boolean;
    /** A command palette, mention list or other popup owns the arrow keys. */
    popupOpen: boolean;
  },
): boolean {
  if (event.key !== "ArrowUp") return false;
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
  // 229 is the IME "process" key some engines report instead of isComposing.
  if (event.nativeEvent?.isComposing === true) return false;
  if (event.keyCode === 229 || event.nativeEvent?.keyCode === 229) return false;
  if (field.popupOpen || field.hasOtherContent) return false;
  if (field.value.length > 0) return false;
  return (field.selectionStart ?? 0) === 0 && (field.selectionEnd ?? 0) === 0;
}

/**
 * The newest waiting human prompt this person may pull back: the last one in
 * queue order (the one that would run last), queued, not mid-mutation, not a
 * once personal-resource attachment (the server refuses those), and initiated
 * by this viewer when one is given.
 */
export function latestRecallableQueuedTurn(
  turns: readonly SessionTurn[],
  mutationFor: (turnId: string) => QueueMutationKind | null,
  subjectId?: string | null,
): SessionTurn | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.status !== "queued") continue;
    if (turn.source !== "user" && turn.source !== "api") continue;
    if (mutationFor(turn.id) !== null) continue;
    if (turn.personalResources?.mode === "once") continue;
    if (subjectId && turn.initiator?.subjectId !== subjectId) continue;
    return turn;
  }
  return null;
}

/**
 * A just-sent prompt still on its way into the queue. Until it shows up there,
 * "the latest waiting prompt" is unknown, so recall waits rather than pulling
 * back an older one.
 */
export function hasQueuedSendInFlight(
  messages: readonly ComposerOptimisticMessage[] | undefined,
  queuedTurnIds: ReadonlySet<string>,
  queueVersion: number | null | undefined,
): boolean {
  // Same projection as the queue panel's optimistic rows; failed sends stay in
  // the composer's retry UI and never block recall.
  return (messages ?? []).some((message) =>
    isQueuedSendInFlight(message, queuedTurnIds, queueVersion),
  );
}

function isQueuedSendInFlight(
  message: ComposerOptimisticMessage,
  queuedTurnIds: ReadonlySet<string>,
  queueVersion: number | null | undefined,
): boolean {
  return (
    message.delivery === "send" &&
    message.destination === "queue" &&
    message.state !== "failed" &&
    (!message.turnId || !queuedTurnIds.has(message.turnId)) &&
    !(
      message.turnId &&
      message.appliedQueueVersion != null &&
      queueVersion != null &&
      queueVersion >= message.appliedQueueVersion
    )
  );
}

/**
 * Wire a session's queue to its composer for Up-arrow recall. The withdraw is
 * the same atomic server checkout as the queue's Edit action, so a prompt the
 * agent already took can never be duplicated or lost.
 *
 * The queue row shows a just-sent prompt as waiting before the server's queue
 * snapshot includes it. Up pressed in that window waits for the send to settle
 * and then recalls it, so one press is always enough.
 */
export function useQueuedPromptRecall({
  queue,
  composer,
  subjectId,
  enabled = true,
}: {
  queue: Pick<UseTurnQueueResult, "queue" | "snapshot" | "mutationFor" | "recallTurn">;
  composer:
    | Pick<
        ComposerState,
        | "value"
        | "setValue"
        | "hasDraftContent"
        | "draftRevision"
        | "draftLoading"
        | "draftPersistence"
        | "applyDraft"
        | "sending"
        | "optimisticMessages"
      >
    | undefined;
  subjectId?: string | null | undefined;
  enabled?: boolean | undefined;
}): ComposerQueuedRecall | undefined {
  const candidate = latestRecallableQueuedTurn(queue.queue, queue.mutationFor, subjectId);
  const settling = composer ? recallSettling(composer, queue) : false;
  const live = useRef({ queue, composer, subjectId });
  live.current = { queue, composer, subjectId };
  // Resolved after the commit in which no send is settling any more (true), or
  // on unmount and timeout (false).
  const settleWaiters = useRef(new Set<(settled: boolean) => void>());
  useEffect(() => {
    if (settling || settleWaiters.current.size === 0) return;
    const waiters = [...settleWaiters.current];
    settleWaiters.current.clear();
    for (const resolve of waiters) resolve(true);
  });
  useEffect(() => {
    const waiters = settleWaiters.current;
    return () => {
      const pending = [...waiters];
      waiters.clear();
      for (const resolve of pending) resolve(false);
    };
  }, []);
  const supported =
    enabled &&
    composer !== undefined &&
    composer.draftPersistence !== "disabled" &&
    queue.recallTurn !== undefined;
  const recall = useCallback(async (): Promise<QueuedPromptRecallOutcome> => {
    let current = live.current;
    let target = current.composer;
    if (!target || target.draftPersistence === "disabled" || !current.queue.recallTurn) {
      return "unavailable";
    }
    if (target.draftLoading || target.hasDraftContent()) return "unavailable";
    // Prompts already waiting when Up was pressed. After waiting for a send,
    // only the just-sent prompt may be recalled, never an older one instead.
    let waitingBeforeSend: ReadonlySet<string> | null = null;
    let sendsInFlight: ReadonlySet<string> = new Set();
    if (recallSettling(target, current.queue)) {
      waitingBeforeSend = new Set(current.queue.queue.map((turn) => turn.id));
      sendsInFlight = inFlightQueueSends(target, current.queue);
      const settled = await new Promise<boolean>((resolve) => {
        const waiters = settleWaiters.current;
        const timer = setTimeout(() => {
          waiters.delete(finish);
          resolve(false);
        }, QUEUED_RECALL_SETTLE_TIMEOUT_MS);
        function finish(value: boolean) {
          clearTimeout(timer);
          resolve(value);
        }
        waiters.add(finish);
      });
      if (!settled) return "unavailable";
      current = live.current;
      target = current.composer;
      if (!target || target.draftPersistence === "disabled") return "unavailable";
      // Typing while the send settled means a new message, not an edit.
      if (target.draftLoading || target.hasDraftContent()) return "unavailable";
      if (recallSettling(target, current.queue)) return "unavailable";
    }
    const recallTurn = current.queue.recallTurn;
    if (!recallTurn) return "unavailable";
    const turn = latestRecallableQueuedTurn(
      current.queue.queue,
      current.queue.mutationFor,
      current.subjectId,
    );
    if (!turn || waitingBeforeSend?.has(turn.id)) {
      // The just-sent prompt is not waiting: the agent took it as it landed.
      return waitingBeforeSend && sentPromptLeftQueue(target, current.queue, sendsInFlight)
        ? "already_sent"
        : "unavailable";
    }
    const result = await recallTurn(turn.id, { expectedDraftRevision: target.draftRevision });
    if (result.status === "recalled") {
      const latest = live.current.composer ?? target;
      // Text typed while the withdraw was in flight may not have reached the
      // server draft yet; keep it after the recalled prompt instead of losing it.
      const typedMeanwhile = latest.value;
      latest.applyDraft(result.draft);
      if (typedMeanwhile.length > 0) {
        latest.setValue(
          result.draft.text.length > 0 ? `${result.draft.text}\n${typedMeanwhile}` : typedMeanwhile,
        );
      }
      return "recalled";
    }
    return result.status === "already_sent" ? "already_sent" : "unavailable";
  }, []);
  return useMemo(
    () =>
      supported
        ? {
            // While a send settles the row already shows it as queued, so Up
            // is taken now and `recall` waits for it to land.
            available: candidate !== null || settling,
            turnId: settling ? null : (candidate?.id ?? null),
            recall,
          }
        : undefined,
    [candidate, recall, settling, supported],
  );
}

function recallSettling(
  composer: Pick<ComposerState, "sending" | "optimisticMessages">,
  queue: Pick<UseTurnQueueResult, "queue" | "snapshot">,
): boolean {
  if (composer.sending) return true;
  if (!composer.optimisticMessages?.length) return false;
  return hasQueuedSendInFlight(
    composer.optimisticMessages,
    new Set(queue.queue.map((turn) => turn.id)),
    queue.snapshot?.version,
  );
}

function inFlightQueueSends(
  composer: Pick<ComposerState, "optimisticMessages">,
  queue: Pick<UseTurnQueueResult, "queue" | "snapshot">,
): ReadonlySet<string> {
  const queuedTurnIds = new Set(queue.queue.map((turn) => turn.id));
  return new Set(
    (composer.optimisticMessages ?? [])
      .filter((message) => isQueuedSendInFlight(message, queuedTurnIds, queue.snapshot?.version))
      .map((message) => message.clientEventId),
  );
}

/** One of the sends Up waited for was queued, but is no longer waiting. */
function sentPromptLeftQueue(
  composer: Pick<ComposerState, "optimisticMessages">,
  queue: Pick<UseTurnQueueResult, "queue">,
  sends: ReadonlySet<string>,
): boolean {
  const queuedTurnIds = new Set(queue.queue.map((turn) => turn.id));
  return (composer.optimisticMessages ?? []).some(
    (message) =>
      sends.has(message.clientEventId) &&
      message.state !== "failed" &&
      typeof message.turnId === "string" &&
      !queuedTurnIds.has(message.turnId),
  );
}
