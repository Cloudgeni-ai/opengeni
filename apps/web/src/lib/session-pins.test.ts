import { describe, expect, test } from "bun:test";

import type { Session } from "@/types";
import {
  applySessionPinProjection,
  applySessionRailProjection,
  mergeSessionContextProjection,
  notifySessionPinChanged,
  reconcileFailedSessionPin,
  subscribeToSessionPinChanges,
} from "./session-pins";

const session = {
  id: "00000000-0000-4000-8000-000000000026",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  status: "running",
  initialMessage: "Keep this lifecycle projection",
  pinned: false,
  pinnedAt: null,
  pinVersion: 0,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:01:00.000Z",
} as Session;

describe("session pin reconciliation", () => {
  test("merges only authoritative personal pin fields", () => {
    const updated = applySessionPinProjection(session, {
      id: session.id,
      workspaceId: session.workspaceId,
      pinned: true,
      pinnedAt: "2026-07-10T00:02:00.000Z",
      pinVersion: 3,
    });

    expect(updated).not.toBe(session);
    expect(updated).toMatchObject({
      status: "running",
      initialMessage: "Keep this lifecycle projection",
      pinned: true,
      pinnedAt: "2026-07-10T00:02:00.000Z",
      pinVersion: 3,
    });
  });

  test("ignores another session or workspace and preserves referential stability", () => {
    expect(
      applySessionPinProjection(session, {
        id: "00000000-0000-4000-8000-000000000099",
        workspaceId: session.workspaceId,
        pinned: true,
        pinnedAt: "2026-07-10T00:02:00.000Z",
        pinVersion: 1,
      }),
    ).toBe(session);
    expect(
      applySessionPinProjection(session, {
        id: session.id,
        workspaceId: "00000000-0000-4000-8000-000000000002",
        pinned: true,
        pinnedAt: "2026-07-10T00:02:00.000Z",
        pinVersion: 1,
      }),
    ).toBe(session);
    expect(
      applySessionPinProjection(session, {
        id: session.id,
        workspaceId: session.workspaceId,
        pinned: false,
        pinnedAt: null,
        pinVersion: 0,
      }),
    ).toBe(session);
  });

  test("never lets a stale list or mutation response regress a newer pin revision", () => {
    const current = {
      ...session,
      pinned: true,
      pinnedAt: "2026-07-10T00:03:00.000Z",
      pinVersion: 4,
    };

    expect(
      applySessionPinProjection(current, {
        id: session.id,
        workspaceId: session.workspaceId,
        pinned: false,
        pinnedAt: null,
        pinVersion: 3,
      }),
    ).toBe(current);

    // Equal revisions are allowed to replace an optimistic timestamp with the
    // canonical timestamp returned by the server.
    expect(
      applySessionPinProjection(current, {
        id: session.id,
        workspaceId: session.workspaceId,
        pinned: true,
        pinnedAt: "2026-07-10T00:02:59.000Z",
        pinVersion: 4,
      }),
    ).toMatchObject({
      pinned: true,
      pinnedAt: "2026-07-10T00:02:59.000Z",
      pinVersion: 4,
    });
  });

  test("a failed first pin may reconcile the exact optimistic version back to absent", () => {
    const optimistic = {
      ...session,
      pinned: true,
      pinnedAt: "2026-07-10T00:04:00.000Z",
      pinVersion: 1,
    };
    expect(reconcileFailedSessionPin(optimistic, optimistic, session)).toEqual(session);
  });

  test("failure reconciliation cannot regress an intervening newer projection", () => {
    const optimistic = {
      ...session,
      pinned: true,
      pinnedAt: "2026-07-10T00:04:00.000Z",
      pinVersion: 1,
    };
    const newer = {
      ...optimistic,
      pinned: false,
      pinnedAt: null,
      pinVersion: 2,
    };
    expect(reconcileFailedSessionPin(newer, optimistic, session)).toBe(newer);
  });

  test("keeps route lifecycle while copying list pin and hierarchy projections", () => {
    const projected = {
      ...session,
      status: "idle",
      initialMessage: "Stale list content",
      pinned: true,
      pinnedAt: "2026-07-10T00:05:00.000Z",
      pinVersion: 5,
      treeStats: {
        directChildren: 2,
        totalDescendants: 4,
        runningDescendants: 1,
        queuedDescendants: 0,
        attentionDescendants: 0,
        pausedDescendants: 0,
        failedDescendants: 0,
      },
    } as Session;

    expect(applySessionRailProjection(session, projected)).toMatchObject({
      status: "running",
      initialMessage: "Keep this lifecycle projection",
      pinned: true,
      pinnedAt: "2026-07-10T00:05:00.000Z",
      pinVersion: 5,
      treeStats: projected.treeStats,
    });
  });

  test("preserves rail identity when a fresh equal tree summary is returned", () => {
    const treeStats = {
      directChildren: 2,
      totalDescendants: 4,
      runningDescendants: 1,
      queuedDescendants: 0,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      truncated: false,
    };
    const current = { ...session, treeStats } as Session;
    const refreshed = { ...current, treeStats: { ...treeStats } };

    expect(applySessionRailProjection(current, refreshed)).toBe(current);
  });

  test("keeps a newer context pin while adopting detail content", () => {
    const current = {
      ...session,
      title: "Renamed in the open route",
      pinned: true,
      pinnedAt: "2026-07-10T00:06:00.000Z",
      pinVersion: 2,
    } as Session;
    const staleDetail = {
      ...session,
      title: "Stale detail title",
      status: "failed",
      pinned: false,
      pinnedAt: null,
      pinVersion: 1,
    } as Session;

    const merged = mergeSessionContextProjection(current, staleDetail);

    expect(merged).toMatchObject({
      title: "Stale detail title",
      status: "failed",
      pinned: true,
      pinnedAt: "2026-07-10T00:06:00.000Z",
      pinVersion: 2,
    });
    expect(merged).not.toBe(staleDetail);
  });

  test("preserves identity when the detail and context pin triples are equal", () => {
    const current = {
      ...session,
      pinned: true,
      pinnedAt: "2026-07-10T00:07:00.000Z",
      pinVersion: 3,
    } as Session;
    const detail = {
      ...current,
      effectiveControl: { ...current.effectiveControl },
    };

    const merged = mergeSessionContextProjection(current, detail);

    expect(merged).toBe(detail);
  });

  test("carries a title_set detail update through a rail pin projection", () => {
    const titleSetDetail = {
      ...session,
      title: "Title from session.title_set",
      effectiveControl: { ...session.effectiveControl },
    } as Session;
    const afterTitle = mergeSessionContextProjection(null, titleSetDetail);
    const afterPin = applySessionPinProjection(afterTitle, {
      id: session.id,
      workspaceId: session.workspaceId,
      pinned: true,
      pinnedAt: "2026-07-10T00:08:00.000Z",
      pinVersion: 1,
    });

    expect(afterPin).toMatchObject({
      title: "Title from session.title_set",
      pinned: true,
      pinnedAt: "2026-07-10T00:08:00.000Z",
      pinVersion: 1,
    });
  });

  test("preserves identity when failed reconciliation already matches authoritative state", () => {
    const optimistic = {
      ...session,
      pinned: true,
      pinnedAt: "2026-07-10T00:09:00.000Z",
      pinVersion: 1,
    } as Session;
    const authoritative = {
      id: session.id,
      workspaceId: session.workspaceId,
      pinned: true,
      pinnedAt: optimistic.pinnedAt,
      pinVersion: 1,
    };

    expect(reconcileFailedSessionPin(optimistic, optimistic, authoritative)).toBe(optimistic);
  });

  test("deduplicates BroadcastChannel delivery for one cross-tab mutation", () => {
    type Listener = (event: { data: unknown }) => void;
    class FakeBroadcastChannel {
      static readonly instances: FakeBroadcastChannel[] = [];
      readonly name: string;
      readonly listeners = new Set<Listener>();

      constructor(name: string) {
        this.name = name;
        FakeBroadcastChannel.instances.push(this);
      }

      addEventListener(_type: "message", listener: Listener): void {
        this.listeners.add(listener);
      }

      postMessage(data: unknown): void {
        for (const instance of FakeBroadcastChannel.instances) {
          if (instance === this || instance.name !== this.name) continue;
          for (const listener of instance.listeners) {
            listener({ data });
            listener({ data });
          }
        }
      }

      close(): void {
        this.listeners.clear();
      }
    }

    const original = globalThis.BroadcastChannel;
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: FakeBroadcastChannel,
      writable: true,
    });
    try {
      const changes: string[] = [];
      const cleanup = subscribeToSessionPinChanges("workspace-1", (sessionId) => {
        changes.push(sessionId);
      });

      notifySessionPinChanged("workspace-1", session.id);

      expect(changes).toEqual([session.id]);
      cleanup();
    } finally {
      Object.defineProperty(globalThis, "BroadcastChannel", {
        configurable: true,
        value: original,
        writable: true,
      });
    }
  });
});
