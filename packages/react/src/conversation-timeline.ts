import type { ComposerState } from "./hooks/use-composer";
import type { UseTurnQueueResult } from "./hooks/use-turn-queue";
import type { TimelineItem, UserMessageItem } from "./timeline/types";

/** Keep pending prompts in the queue, not duplicated in the conversation. */
export function conversationTimeline(
  items: TimelineItem[],
  queue: Pick<UseTurnQueueResult, "queue" | "snapshot" | "acceptedSteers">,
  composer: Pick<
    ComposerState,
    "optimisticMessages" | "retryOptimisticMessage" | "removeOptimisticMessage"
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
              onRetry: () => composer.retryOptimisticMessage?.(message.clientEventId),
              onRemove: () => composer.removeOptimisticMessage?.(message.clientEventId),
            }
          : {}),
      },
    }));
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
  return [...visible, ...optimistic, ...steers];
}
