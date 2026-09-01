import type {
  SessionComposerOptimisticMessage,
  TimelineItem,
  TurnQueueStoreSnapshot,
  UserMessageItem,
} from "@opengeni/sdk/session";

export function projectOptimisticChatMessages(
  timeline: readonly TimelineItem[],
  messages: readonly SessionComposerOptimisticMessage[],
  actions: {
    retry(clientEventId: string): void;
    remove(clientEventId: string): void;
  },
): TimelineItem[] {
  const visibleClientEventIds = new Set(
    timeline
      .filter((item): item is UserMessageItem => item.kind === "user-message")
      .flatMap((item) => {
        const key = item.reconciliationKey;
        return key?.startsWith("user-message:") ? [key.slice("user-message:".length)] : [];
      }),
  );
  const optimistic: UserMessageItem[] = messages
    .filter(
      (message) =>
        message.destination === "chat" && !visibleClientEventIds.has(message.clientEventId),
    )
    .map((message) => ({
      kind: "user-message",
      id: `optimistic:${message.clientEventId}`,
      reconciliationKey: `user-message:${message.clientEventId}`,
      text: message.text,
      annotations: message.annotations.map((annotation, ordinal) => ({ ...annotation, ordinal })),
      resources: [...message.resources],
      tools: [],
      occurredAt: message.occurredAt,
      delivery: {
        state: message.state,
        ...(message.error ? { error: message.error } : {}),
        ...(message.state === "failed"
          ? {
              onRetry: () => actions.retry(message.clientEventId),
              onRemove: () => actions.remove(message.clientEventId),
            }
          : {}),
      },
    }));
  return [...timeline, ...optimistic];
}

export function projectOptimisticQueuedMessages(
  messages: readonly SessionComposerOptimisticMessage[],
  queue: Pick<TurnQueueStoreSnapshot, "queue" | "snapshot">,
): SessionComposerOptimisticMessage[] {
  const queuedTurnIds = new Set(queue.queue.map((turn) => turn.id));
  return messages.filter(
    (message) =>
      message.delivery === "send" &&
      message.destination === "queue" &&
      (!message.turnId || !queuedTurnIds.has(message.turnId)) &&
      !(
        message.turnId &&
        message.appliedQueueVersion !== null &&
        message.appliedQueueVersion !== undefined &&
        queue.snapshot &&
        queue.snapshot.version >= message.appliedQueueVersion
      ),
  );
}
