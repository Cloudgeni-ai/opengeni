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
 * snapshot includes it. Up pressed in that window is taken at once: recall
 * follows exactly the sends in flight at the press and pulls back the newest
 * of them once it lands, so one press is always enough.
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
  const queueSendInFlight = composer
    ? hasQueuedSendInFlight(
        composer.optimisticMessages,
        new Set(queue.queue.map((turn) => turn.id)),
        queue.snapshot?.version,
      )
    : false;
  const live = useRef({ queue, composer, subjectId });
  live.current = { queue, composer, subjectId };
  // Each waiting press re-checks live state after every commit, and is
  // cancelled on unmount.
  const settleWaiters = useRef(new Set<SettleWaiter>());
  useEffect(() => {
    for (const waiter of [...settleWaiters.current]) waiter.check();
  });
  useEffect(() => {
    const waiters = settleWaiters.current;
    return () => {
      for (const waiter of [...waiters]) waiter.cancel();
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
    let queued = current.queue.queue;
    // A just-sent prompt on its way into the queue: follow exactly the sends in
    // flight now, never an older prompt and never one sent after this press.
    const tracked = inFlightQueueSends(target, current.queue);
    if (tracked.size > 0) {
      const settled = await waitForTrackedSends(settleWaiters.current, live, tracked);
      if (!settled) return "unavailable";
      current = live.current;
      target = current.composer;
      if (!target || target.draftPersistence === "disabled") return "unavailable";
      if (target.draftLoading || target.hasDraftContent()) return "unavailable";
      const trackedTurnIds = new Set(
        [...tracked.values()].filter((turnId): turnId is string => turnId !== null),
      );
      queued = current.queue.queue.filter((turn) => trackedTurnIds.has(turn.id));
      if (
        latestRecallableQueuedTurn(queued, current.queue.mutationFor, current.subjectId) === null
      ) {
        const waitingIds = new Set(current.queue.queue.map((turn) => turn.id));
        // Placed in the queue, then started before this read: already sent.
        return [...trackedTurnIds].some((turnId) => !waitingIds.has(turnId))
          ? "already_sent"
          : "unavailable";
      }
    } else if (recallSettling(target, current.queue)) {
      // A Steer or other blocking send is running: nothing of ours is landing.
      return "unavailable";
    }
    const recallTurn = current.queue.recallTurn;
    if (!recallTurn) return "unavailable";
    const turn = latestRecallableQueuedTurn(queued, current.queue.mutationFor, current.subjectId);
    if (!turn) return "unavailable";
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
            // The row already shows a send on its way as queued, so Up is
            // taken now and `recall` waits for it to land.
            available: (candidate !== null && !settling) || queueSendInFlight,
            turnId: settling ? null : (candidate?.id ?? null),
            recall,
          }
        : undefined,
    [candidate, queueSendInFlight, recall, settling, supported],
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

/** Queue sends still on their way in, by client event id, with any turn id known. */
function inFlightQueueSends(
  composer: Pick<ComposerState, "optimisticMessages">,
  queue: Pick<UseTurnQueueResult, "queue" | "snapshot">,
): Map<string, string | null> {
  const queuedTurnIds = new Set(queue.queue.map((turn) => turn.id));
  return new Map(
    (composer.optimisticMessages ?? [])
      .filter((message) => isQueuedSendInFlight(message, queuedTurnIds, queue.snapshot?.version))
      .map((message) => [message.clientEventId, message.turnId ?? null]),
  );
}

type SettleWaiter = { check: () => void; cancel: () => void };

type LiveRecallState = {
  current: {
    queue: Pick<UseTurnQueueResult, "queue" | "snapshot">;
    composer: Pick<ComposerState, "hasDraftContent" | "optimisticMessages"> | undefined;
  };
};

/**
 * Wait until every tracked send has settled: landed in the queue snapshot,
 * failed, or left (started or withdrawn). Records each send's turn id as it
 * becomes known, since the optimistic entry can go away once its turn starts.
 * Resolves false on timeout, unmount, typing, or a newer send, which all mean
 * the person moved on from this press.
 */
function waitForTrackedSends(
  waiters: Set<SettleWaiter>,
  live: LiveRecallState,
  tracked: Map<string, string | null>,
): Promise<boolean> {
  const known = new Set(
    (live.current.composer?.optimisticMessages ?? []).map((message) => message.clientEventId),
  );
  return new Promise<boolean>((resolve) => {
    const finish = (settled: boolean) => {
      clearTimeout(timer);
      waiters.delete(waiter);
      resolve(settled);
    };
    const waiter: SettleWaiter = {
      cancel: () => finish(false),
      check: () => {
        const { composer, queue } = live.current;
        if (!composer || composer.hasDraftContent()) return finish(false);
        const messages = composer.optimisticMessages ?? [];
        if (messages.some((message) => !known.has(message.clientEventId))) return finish(false);
        const queuedTurnIds = new Set(queue.queue.map((turn) => turn.id));
        let pending = false;
        for (const clientEventId of tracked.keys()) {
          const message = messages.find((candidate) => candidate.clientEventId === clientEventId);
          if (message?.turnId) tracked.set(clientEventId, message.turnId);
          if (message && isQueuedSendInFlight(message, queuedTurnIds, queue.snapshot?.version)) {
            pending = true;
          }
        }
        if (!pending) finish(true);
      },
    };
    const timer = setTimeout(() => finish(false), QUEUED_RECALL_SETTLE_TIMEOUT_MS);
    waiters.add(waiter);
  });
}
