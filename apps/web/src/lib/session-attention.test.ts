import { describe, expect, test } from "bun:test";

import type { Session } from "@/types";
import {
  applySessionAttentionProjection,
  latestSessionAttentionProjection,
  notifySessionAttentionChanged,
  subscribeToSessionAttentionChanges,
} from "./session-attention";

const session = {
  id: "00000000-0000-4000-8000-000000000026",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  unread: true,
  activelyWorking: false,
  attentionVersion: 4,
  lastSequence: 20,
} as Session;

describe("session attention reconciliation", () => {
  test("keeps a route acknowledgement over an equal stale rail page", () => {
    const acknowledged = applySessionAttentionProjection(session, {
      ...session,
      unread: false,
    });

    expect(acknowledged).toMatchObject({ unread: false, attentionVersion: 4 });
  });

  test("does not hide a newer explicit state or newer durable activity", () => {
    const optimistic = { ...session, unread: false };
    const newerMutation = { ...session, attentionVersion: 5 } as Session;
    const newerEvent = { ...session, lastSequence: 21 } as Session;

    expect(applySessionAttentionProjection(newerMutation, optimistic)).toBe(newerMutation);
    expect(applySessionAttentionProjection(newerEvent, optimistic)).toBe(newerEvent);
  });

  test("keeps the newest override when HTTP responses arrive out of order", () => {
    const newest = { ...session, unread: false, attentionVersion: 6, lastSequence: 21 };
    const delayed = { ...session, unread: false, attentionVersion: 5, lastSequence: 20 };

    expect(latestSessionAttentionProjection(newest, delayed)).toBe(newest);
    expect(latestSessionAttentionProjection(delayed, newest)).toBe(newest);
  });

  test("notifies and unsubscribes same-tab listeners", () => {
    const received: string[] = [];
    const unsubscribe = subscribeToSessionAttentionChanges((projection) => {
      received.push(projection.id);
    });

    notifySessionAttentionChanged(session);
    unsubscribe();
    notifySessionAttentionChanged(session);

    expect(received).toEqual([session.id]);
  });
});
