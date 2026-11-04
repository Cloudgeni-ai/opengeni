import type { ComposerState } from "./hooks/use-composer";
import type { UseTurnQueueResult } from "./hooks/use-turn-queue";
import type { TimelineItem, UserMessageItem } from "./timeline/types";

/** Keep pending prompts in the queue, not duplicated in the conversation. */
export function conversationTimeline(
  items: TimelineItem[],
  queue: Pick<UseTurnQueueResult, "queue" | "snapshot" | "acceptedSteers">,
  composer: Pick<
    ComposerState,
    | "optimisticMessages"
    | "retryOptimisticMessage"
    | "restoreOptimisticMessage"
    | "removeOptimisticMessage"
  >,
): TimelineItem[] {
  const queued = new Set(
    queue.queue
      .filter((turn) => turn.metadata.delivery !== "steer")
      .map((turn) => turn.triggerEventId),
  );
  const pending = composer.optimisticMessages ?? [];
  const pendingQueue = new Set(
    pending
      .filter(
        (message) =>
          message.destination === "queue" &&
          !(
            message.turnId &&
            message.appliedQueueVersion != null &&
            queue.snapshot &&
            queue.snapshot.version >= message.appliedQueueVersion &&
            !queue.queue.some((turn) => turn.id === message.turnId)
          ),
      )
      .map((message) => `user-message:${message.clientEventId}`),
  );
  const visible = items.filter(
    (item) =>
      item.kind !== "user-message" ||
      (!queued.has(item.id) && !pendingQueue.has(item.reconciliationKey ?? "")),
  );
  const keys = new Set(
    visible.flatMap((item) => (item.kind === "user-message" ? [item.reconciliationKey] : [])),
  );
  const optimistic: UserMessageItem[] = pending
    .filter(
      (message) =>
        (message.destination === "chat" || message.state === "failed") &&
        !keys.has(`user-message:${message.clientEventId}`) &&
        !queue.queue.some((turn) => turn.id === message.turnId),
    )
    .map((message) => ({
      kind: "user-message",
      id: `optimistic:${message.clientEventId}`,
      reconciliationKey: `user-message:${message.clientEventId}`,
      text: message.text,
      annotations: message.annotations.map((annotation, ordinal) => ({ ...annotation, ordinal })),
      resources: message.resources,
      tools: [],
      occurredAt: message.occurredAt,
      delivery: {
        state: message.state,
        ...(message.error ? { error: message.error } : {}),
        ...(message.state === "failed"
          ? {
              ...(message.retryable !== false && composer.retryOptimisticMessage
                ? { onRetry: () => composer.retryOptimisticMessage?.(message.clientEventId) }
                : {}),
              ...(message.retryable === false && composer.restoreOptimisticMessage
                ? { onEdit: () => composer.restoreOptimisticMessage?.(message.clientEventId) }
                : {}),
              onRemove: () => composer.removeOptimisticMessage?.(message.clientEventId),
            }
          : {}),
      },
    }));
  const failed = optimistic.filter((message) => message.delivery?.state === "failed");
  const unsent = optimistic.filter((message) => message.delivery?.state !== "failed");
  const ids = new Set(visible.map((item) => item.id));
  const steers: UserMessageItem[] = (queue.acceptedSteers ?? [])
    .filter((steer) => !ids.has(steer.triggerEventId))
    .map((steer) => ({
      kind: "user-message",
      id: steer.triggerEventId,
      text: steer.text,
      annotations: steer.annotations,
      resources: steer.resources,
      tools: steer.tools,
      occurredAt: steer.occurredAt,
      delivery: { state: steer.state },
    }));
  return [...placeFailedSends(visible, failed), ...unsent, ...steers];
}

/**
 * A failed send stays where it was written. A person who sent something newer
 * has moved on, so an old failure must not sit under that message and its work,
 * looking like the latest thing they said. With nothing newer it stays last,
 * next to the composer, where its recovery actions are seen.
 */
function placeFailedSends(items: TimelineItem[], failed: UserMessageItem[]): TimelineItem[] {
  if (failed.length === 0) return items;
  const before = new Map<number, UserMessageItem[]>();
  const last: UserMessageItem[] = [];
  for (const message of failed) {
    const sentAt = Date.parse(message.occurredAt);
    const newer = items.findIndex(
      (item) => item.kind === "user-message" && Date.parse(item.occurredAt) > sentAt,
    );
    if (newer === -1) {
      last.push(message);
    } else {
      before.set(newer, [...(before.get(newer) ?? []), message]);
    }
  }
  return [...items.flatMap((item, index) => [...(before.get(index) ?? []), item]), ...last];
}
