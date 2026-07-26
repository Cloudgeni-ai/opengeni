import { describe, expect, test } from "bun:test";

import type { Session } from "@/types";
import { applySessionPinProjection, reconcileFailedSessionPin } from "./session-pins";

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
});
