import { describe, expect, test } from "bun:test";

import type { Session } from "@/types";
import {
  applySessionAttentionProjection,
  applySessionAttentionProjections,
  localSessionDeliveryAttentionCounts,
  latestSessionAttentionProjection,
  notifySessionAttentionChanged,
  sessionReadProjectionKey,
  shouldAcknowledgeActiveSession,
  shouldProjectActiveSessionRead,
  subscribeToSessionAttentionChanges,
  subscribeToLocalSessionDeliveryAttention,
  updateLocalSessionDeliveryAttention,
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

  test("does not let an equal-coordinate unread projection resurrect a viewed chat", () => {
    const read = { ...session, unread: false } as Session;
    const staleUnread = { ...session, unread: true };

    expect(applySessionAttentionProjection(read, staleUnread)).toBe(read);
    expect(latestSessionAttentionProjection(read, staleUnread)).toBe(read);
    expect(
      applySessionAttentionProjection(read, {
        ...staleUnread,
        attentionVersion: (session.attentionVersion ?? 0) + 1,
      }).unread,
    ).toBe(true);
  });

  test("projects a viewed failed child through every loaded ancestor", () => {
    const root = {
      ...session,
      id: "root",
      unread: false,
      treeStats: {
        directChildren: 1,
        totalDescendants: 2,
        runningDescendants: 0,
        queuedDescendants: 0,
        attentionDescendants: 0,
        pausedDescendants: 0,
        failedDescendants: 1,
        unreadFailedDescendants: 1,
        unreadDescendants: 2,
        activelyWorkingDescendants: 0,
        truncated: false,
      },
    } as Session;
    const parent = {
      ...root,
      id: "parent",
      parentSessionId: root.id,
      unread: true,
      treeStats: {
        ...root.treeStats!,
        directChildren: 1,
        totalDescendants: 1,
        unreadDescendants: 1,
      },
    } as Session;
    const child = {
      ...session,
      id: "child",
      parentSessionId: parent.id,
      status: "failed",
    } as Session;

    const projected = applySessionAttentionProjections(
      [root, parent, child],
      new Map([
        [child.id, { ...child, unread: false }],
        [parent.id, { ...parent, unread: false }],
      ]),
    );

    expect(projected.find((candidate) => candidate.id === child.id)?.unread).toBe(false);
    expect(projected.find((candidate) => candidate.id === parent.id)?.unread).toBe(false);
    for (const ancestorId of [root.id, parent.id]) {
      expect(projected.find((candidate) => candidate.id === ancestorId)?.treeStats).toMatchObject({
        failedDescendants: 1,
        unreadFailedDescendants: 0,
        unreadDescendants: 0,
      });
    }
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

  test("tracks local message-delivery attention without changing durable session state", () => {
    const durableBefore = { ...session };
    const revisions: Array<Array<[string, number]>> = [];
    const unsubscribe = subscribeToLocalSessionDeliveryAttention(() => {
      revisions.push([...localSessionDeliveryAttentionCounts(session.workspaceId)]);
    });

    updateLocalSessionDeliveryAttention({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      failedMessageCount: 2,
    });
    expect(localSessionDeliveryAttentionCounts(session.workspaceId)).toEqual(
      new Map([[session.id, 2]]),
    );
    expect(session).toEqual(durableBefore);

    updateLocalSessionDeliveryAttention({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      failedMessageCount: 0,
    });
    unsubscribe();

    expect(revisions).toEqual([[[session.id, 2]], []]);
    expect(localSessionDeliveryAttentionCounts(session.workspaceId).size).toBe(0);
  });
});

describe("active session read acknowledgement", () => {
  test("a later rendered event frontier requires a new acknowledgement", () => {
    const acknowledged = sessionReadProjectionKey(session.id, 20);
    expect(sessionReadProjectionKey(session.id, 20)).toBe(acknowledged);
    expect(sessionReadProjectionKey(session.id, 21)).not.toBe(acknowledged);
  });

  test("acknowledges the exact unread chat as soon as it is foregrounded", () => {
    expect(
      shouldAcknowledgeActiveSession({
        activeSessionId: session.id,
        workspaceId: session.workspaceId,
        session,
        documentVisible: true,
        windowFocused: true,
      }),
    ).toBe(true);
  });

  test("clears and acknowledges the foreground route before its live tip finishes loading", () => {
    expect(
      shouldProjectActiveSessionRead({
        activeSessionId: session.id,
        workspaceId: session.workspaceId,
        session,
        documentVisible: true,
        windowFocused: true,
      }),
    ).toBe(true);
    expect(
      shouldAcknowledgeActiveSession({
        activeSessionId: session.id,
        workspaceId: session.workspaceId,
        session,
        documentVisible: true,
        windowFocused: true,
      }),
    ).toBe(true);
  });

  test("does not consume unread state in the background", () => {
    for (const candidate of [
      { documentVisible: false, windowFocused: true },
      { documentVisible: true, windowFocused: false },
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
        }),
      ).toBe(false);
    }
  });
});
