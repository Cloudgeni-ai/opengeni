import { describe, expect, test } from "bun:test";
import type {
  SessionComposerOptimisticMessage,
  TimelineItem,
  TurnQueueStoreSnapshot,
} from "@opengeni/sdk/session";
import {
  projectOptimisticChatMessages,
  projectOptimisticQueuedMessages,
} from "../src/optimistic-messages";

function optimistic(
  overrides: Partial<SessionComposerOptimisticMessage> = {},
): SessionComposerOptimisticMessage {
  return {
    clientEventId: "client-1",
    delivery: "send",
    destination: "chat",
    text: "Retry this message",
    annotations: [],
    resources: [],
    occurredAt: "2026-09-01T12:00:00.000Z",
    state: "failed",
    error: "delivery failed",
    ...overrides,
  };
}

describe("native optimistic message projection", () => {
  test("keeps failed chat messages visible with retry and remove actions", () => {
    const actions: string[] = [];
    const projected = projectOptimisticChatMessages([], [optimistic()], {
      retry: (id) => actions.push(`retry:${id}`),
      remove: (id) => actions.push(`remove:${id}`),
    });
    const item = projected[0];
    expect(item).toMatchObject({
      kind: "user-message",
      id: "optimistic:client-1",
      text: "Retry this message",
      delivery: { state: "failed", error: "delivery failed" },
    });
    if (item?.kind !== "user-message") throw new Error("Expected optimistic user message");
    item.delivery?.onRetry?.();
    item.delivery?.onRemove?.();
    expect(actions).toEqual(["retry:client-1", "remove:client-1"]);
  });

  test("does not duplicate a message after its durable reconciliation key appears", () => {
    const durable = {
      kind: "user-message",
      id: "event-1",
      reconciliationKey: "user-message:client-1",
      text: "Retry this message",
      resources: [],
      tools: [],
      occurredAt: "2026-09-01T12:00:01.000Z",
    } satisfies TimelineItem;
    expect(
      projectOptimisticChatMessages([durable], [optimistic()], {
        retry: () => undefined,
        remove: () => undefined,
      }),
    ).toEqual([durable]);
  });

  test("retains only queue messages not yet represented or settled authoritatively", () => {
    const queue = {
      queue: [{ id: "turn-present" }],
      snapshot: { version: 8 },
    } as TurnQueueStoreSnapshot;
    expect(
      projectOptimisticQueuedMessages(
        [
          optimistic({ clientEventId: "visible", destination: "queue" }),
          optimistic({ clientEventId: "present", destination: "queue", turnId: "turn-present" }),
          optimistic({
            clientEventId: "settled",
            destination: "queue",
            turnId: "turn-gone",
            appliedQueueVersion: 8,
          }),
        ],
        queue,
      ).map((message) => message.clientEventId),
    ).toEqual(["visible"]);
  });
});
