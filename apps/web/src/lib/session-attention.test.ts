import { describe, expect, test } from "bun:test";

import type { Session } from "@/types";
import {
  applySessionAttentionProjection,
  latestSessionAttentionProjection,
  notifySessionAttentionChanged,
  sessionReadProjectionKey,
  shouldAcknowledgeActiveSession,
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

describe("active session read acknowledgement", () => {
  test("a later rendered event frontier requires a new acknowledgement", () => {
    const acknowledged = sessionReadProjectionKey(session.id, 20);
    expect(sessionReadProjectionKey(session.id, 20)).toBe(acknowledged);
    expect(sessionReadProjectionKey(session.id, 21)).not.toBe(acknowledged);
  });

  test("acknowledges the exact unread chat only at the foreground live tip", () => {
    expect(
      shouldAcknowledgeActiveSession({
        activeSessionId: session.id,
        workspaceId: session.workspaceId,
        session,
        documentVisible: true,
        windowFocused: true,
        liveTipLoaded: true,
      }),
    ).toBe(true);
  });

  test("does not consume unread state in the background or from a historical window", () => {
    for (const candidate of [
      { documentVisible: false, windowFocused: true, liveTipLoaded: true },
      { documentVisible: true, windowFocused: false, liveTipLoaded: true },
      { documentVisible: true, windowFocused: true, liveTipLoaded: false },
    ]) {
      expect(
        shouldAcknowledgeActiveSession({
          activeSessionId: session.id,
          workspaceId: session.workspaceId,
          session,
          ...candidate,
        }),
      ).toBe(false);
    }
  });

  test("rejects stale route, workspace, read, archived, and absent projections", () => {
    const candidates = [
      { activeSessionId: "session-b", workspaceId: session.workspaceId, session },
      { activeSessionId: session.id, workspaceId: "workspace-b", session },
      {
        activeSessionId: session.id,
        workspaceId: session.workspaceId,
        session: { ...session, unread: false },
      },
      {
        activeSessionId: session.id,
        workspaceId: session.workspaceId,
        session: { ...session, archived: true },
      },
      { activeSessionId: session.id, workspaceId: session.workspaceId, session: null },
    ];
    for (const candidate of candidates) {
      expect(
        shouldAcknowledgeActiveSession({
          ...candidate,
          documentVisible: true,
          windowFocused: true,
          liveTipLoaded: true,
        }),
      ).toBe(false);
    }
  });
});
