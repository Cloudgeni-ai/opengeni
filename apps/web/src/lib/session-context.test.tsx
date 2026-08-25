import { describe, expect, test } from "bun:test";
import { createElement, useEffect, useState } from "react";

import { registerDom, renderComponent } from "../../../../packages/react/test/render-hook";
import type { Session } from "@/types";
import { sameSessionForContext } from "./session-context";
import * as sessionPins from "./session-pins";
import {
  applySessionPinProjection,
  applySessionRailProjection,
  mergeSessionContextProjection,
  SessionChannelProjectionAuthority,
} from "./session-pins";
import { beginSessionChannelMove, rollbackSessionChannelMove } from "./session-channel-move";
import {
  authoritativeSessionContinuation,
  emptySessionContinuation,
  mergeSessionContinuation,
  rebaseSessionContinuation,
  reconcileRetainedSessionContinuationChannel,
} from "./session-pagination";

registerDom();

const mergeSessionDetailReadProjection =
  (
    sessionPins as typeof sessionPins & {
      mergeSessionDetailReadProjection?: (
        current: Session | null,
        projected: Session,
        authority: SessionChannelProjectionAuthority,
        readGeneration: number,
        accepted: boolean,
      ) => Session | null;
    }
  ).mergeSessionDetailReadProjection ??
  ((current: Session | null, projected: Session, authority: SessionChannelProjectionAuthority) =>
    mergeSessionContextProjection(current, projected, authority, "detail"));

const effectiveControl: Session["effectiveControl"] = {
  state: "active",
  controlVersion: 0,
  controlEtag: "active-0",
  directState: "active",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};

function session(pinned: boolean, pinVersion: number): Session {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    pinned,
    pinnedAt: pinned ? "2026-07-28T00:00:00.000Z" : null,
    pinVersion,
    effectiveControl,
  } as Session;
}

describe("session context equality", () => {
  test("treats freshly allocated equivalent effective controls as unchanged", () => {
    const current = session(false, 0);
    const next = { ...current, effectiveControl: { ...effectiveControl } };

    expect(sameSessionForContext(current, next)).toBe(true);
  });

  test("detects meaningful nested effective-control changes", () => {
    const current = session(false, 0);
    const next = {
      ...current,
      effectiveControl: {
        ...effectiveControl,
        controlVersion: 1,
        controlEtag: "active-1",
      },
    };

    expect(sameSessionForContext(current, next)).toBe(false);
  });

  test("keeps a point-read project move through a stale live route update", () => {
    const staleListAndDetail = {
      ...session(false, 0),
      channelId: "00000000-0000-4000-8000-000000000201",
      status: "idle",
    } as Session;
    const pointReadAfterMove = {
      ...staleListAndDetail,
      channelId: "00000000-0000-4000-8000-000000000202",
    } as Session;
    const liveRouteProjection = {
      ...staleListAndDetail,
      status: "running",
      effectiveControl: {
        ...effectiveControl,
        controlVersion: 1,
        controlEtag: "active-1",
      },
    } as Session;

    const authority = new SessionChannelProjectionAuthority();
    authority.replace({}, [pointReadAfterMove]);
    const reconciled = mergeSessionContextProjection(
      pointReadAfterMove,
      liveRouteProjection,
      authority,
      "live",
    );

    expect(reconciled?.channelId).toBe(pointReadAfterMove.channelId);
    expect(reconciled?.status).toBe("running");
    expect(reconciled?.effectiveControl).toEqual(liveRouteProjection.effectiveControl);
  });

  test("adopts a fresh detail project when no list or point-read projection owns it", () => {
    const staleContext = {
      ...session(false, 0),
      channelId: "00000000-0000-4000-8000-000000000201",
      status: "idle",
    } as Session;
    const freshDetail = {
      ...staleContext,
      channelId: "00000000-0000-4000-8000-000000000202",
      status: "running",
    } as Session;

    const reconciled = mergeSessionContextProjection(
      staleContext,
      freshDetail,
      new SessionChannelProjectionAuthority(),
      "detail",
    );

    expect(reconciled).toBe(freshDetail);
    expect(reconciled?.channelId).toBe(freshDetail.channelId);
  });

  test("does not seed stale route context from a detail rejected after rail unmount", () => {
    const authority = new SessionChannelProjectionAuthority();
    const staleDetail = {
      ...session(false, 0),
      channelId: "00000000-0000-4000-8000-000000000201",
    } as Session;
    const moved = {
      ...staleDetail,
      channelId: "00000000-0000-4000-8000-000000000202",
    } as Session;
    const staleDetailGeneration = authority.beginRead();

    expect(authority.recordRead(moved, authority.beginRead())).toBe(true);
    const accepted = authority.recordRead(staleDetail, staleDetailGeneration);
    expect(accepted).toBe(false);

    expect(
      mergeSessionDetailReadProjection(
        null,
        staleDetail,
        authority,
        staleDetailGeneration,
        accepted,
      )?.channelId,
    ).toBe(moved.channelId);
  });

  test("keeps a loaded list project over a conflicting detail read", () => {
    const authority = new SessionChannelProjectionAuthority();
    const listProjection = {
      ...session(false, 0),
      channelId: "00000000-0000-4000-8000-000000000202",
      status: "idle",
    } as Session;
    const freshDetail = {
      ...listProjection,
      channelId: "00000000-0000-4000-8000-000000000203",
      status: "running",
    } as Session;
    authority.replace({}, [listProjection]);

    const reconciled = mergeSessionContextProjection(
      listProjection,
      freshDetail,
      authority,
      "detail",
    );

    expect(reconciled?.channelId).toBe(listProjection.channelId);
    expect(reconciled?.status).toBe("running");
  });

  test("lets a fresh detail move supersede a continuation row retained past page one", () => {
    const listOwner = {};
    const authority = new SessionChannelProjectionAuthority();
    const retainedPageRow = {
      ...session(false, 0),
      channelId: "00000000-0000-4000-8000-000000000202",
      status: "idle",
      treeStats: {
        directChildren: 1,
        totalDescendants: 1,
        runningDescendants: 0,
        queuedDescendants: 0,
        attentionDescendants: 0,
        pausedDescendants: 0,
        failedDescendants: 0,
      },
    } as Session;
    const remoteMoveDetail = {
      ...retainedPageRow,
      channelId: "00000000-0000-4000-8000-000000000203",
      status: "running",
      treeStats: undefined,
    } as Session;
    let continuation = mergeSessionContinuation(
      emptySessionContinuation(3),
      3,
      3,
      { sessions: [retainedPageRow], nextCursor: null },
      10,
    );

    // The continuation page was loaded from the current page-one snapshot, so
    // it is genuine list evidence and still wins over a conflicting detail.
    authority.replace(listOwner, authoritativeSessionContinuation(continuation, 3, 10));
    expect(
      mergeSessionContextProjection(retainedPageRow, remoteMoveDetail, authority, "detail")
        ?.channelId,
    ).toBe(retainedPageRow.channelId);

    // A newer page-one poll omits this old page-N row. Keep it visible for
    // stable pagination, but release its channel authority so the causally
    // fresh point/detail read can move both context and the selected rail row.
    authority.replace(listOwner, authoritativeSessionContinuation(continuation, 3, 11));
    const afterDetail = mergeSessionContextProjection(
      retainedPageRow,
      remoteMoveDetail,
      authority,
      "detail",
    );
    expect(afterDetail?.channelId).toBe(remoteMoveDetail.channelId);
    continuation = reconcileRetainedSessionContinuationChannel(continuation, 3, 11, afterDetail);
    expect(continuation.sessions[0]?.channelId).toBe(remoteMoveDetail.channelId);
    expect(
      applySessionRailProjection(afterDetail!, retainedPageRow, { channelOwned: false }),
    ).toMatchObject({
      channelId: remoteMoveDetail.channelId,
      status: "running",
      treeStats: retainedPageRow.treeStats,
    });

    // A stale route/SSE projection cannot put the accepted detail move back.
    expect(
      mergeSessionContextProjection(afterDetail, retainedPageRow, authority, "live")?.channelId,
    ).toBe(remoteMoveDetail.channelId);

    // Re-paging from a fresh snapshot restores exact list authority without
    // duplicating the display row.
    continuation = rebaseSessionContinuation(continuation, 3, 3, "fresh-next", 11);
    continuation = mergeSessionContinuation(
      continuation,
      3,
      3,
      { sessions: [remoteMoveDetail], nextCursor: null },
      11,
    );
    expect(continuation.sessions.map((candidate) => candidate.id)).toEqual([retainedPageRow.id]);
    authority.replace(listOwner, authoritativeSessionContinuation(continuation, 3, 11));
    const laterConflictingDetail = {
      ...remoteMoveDetail,
      channelId: "00000000-0000-4000-8000-000000000204",
    } as Session;
    expect(
      mergeSessionContextProjection(afterDetail, laterConflictingDetail, authority, "detail")
        ?.channelId,
    ).toBe(remoteMoveDetail.channelId);
  });

  test("rejects a late stale pins-only channel after newer root and detail evidence", () => {
    const authority = new SessionChannelProjectionAuthority();
    const rootOwner = {};
    const pinsOwner = {};
    const moveOwner = {};
    const channelA = "00000000-0000-4000-8000-000000000202";
    const channelB = "00000000-0000-4000-8000-000000000203";
    const channelC = "00000000-0000-4000-8000-000000000204";
    const staleFetchedSession = {
      ...session(true, 2),
      channelId: channelA,
      status: "idle",
    } as Session;
    const stalePins = { ...staleFetchedSession };
    const freshRoot = { ...staleFetchedSession, channelId: channelB, status: "running" } as Session;
    const freshDetail = {
      ...freshRoot,
      effectiveControl: {
        ...effectiveControl,
        controlVersion: 2,
        controlEtag: "active-2",
      },
    } as Session;

    // The pins-only request starts first and remains gated while root and
    // exact detail reads observe the remote move to B.
    const stalePinsGeneration = authority.beginRead();
    const rootGeneration = authority.beginRead();
    authority.replace(rootOwner, [freshRoot], 0, rootGeneration);
    const detailGeneration = authority.beginRead();
    authority.recordRead(freshDetail, detailGeneration);
    let current = mergeSessionContextProjection(stalePins, freshDetail, authority, "detail");
    expect(current?.channelId).toBe(channelB);

    // The old pins-only A response completes last. It may still contribute pin
    // metadata, but its older request generation cannot regain channel ownership
    // in either the rail or the open route.
    authority.replace(pinsOwner, [stalePins], 0, stalePinsGeneration);
    const projectedLatePins = authority.project(stalePins, stalePinsGeneration);
    expect(projectedLatePins.channelId).toBe(channelB);
    current = applySessionRailProjection(current!, projectedLatePins);
    expect(current).toMatchObject({
      channelId: channelB,
      status: "running",
      effectiveControl: freshDetail.effectiveControl,
    });
    expect(
      mergeSessionContextProjection(current, staleFetchedSession, authority, "live"),
    ).toMatchObject({ channelId: channelB, status: "idle", effectiveControl });

    // An active optimistic move remains the higher-priority operation fence;
    // clearing it restores the newest accepted read rather than stale pins.
    const optimisticMove = { ...freshDetail, channelId: channelC };
    authority.replace(moveOwner, [optimisticMove], 1);
    expect(authority.owns(optimisticMove)).toBe(true);
    authority.clear(moveOwner);
    expect(authority.project(stalePins, stalePinsGeneration).channelId).toBe(channelB);

    // Workspace identity remains part of the evidence key, and a pins page
    // that actually starts later is legitimate new authority.
    expect(
      authority.project(
        {
          ...stalePins,
          workspaceId: "00000000-0000-4000-8000-000000000099",
        },
        stalePinsGeneration,
      ).channelId,
    ).toBe(channelA);
    const freshPinsGeneration = authority.beginRead();
    authority.replace(pinsOwner, [stalePins], 0, freshPinsGeneration);
    expect(authority.project(stalePins, freshPinsGeneration).channelId).toBe(channelA);
  });

  test("releases a rolled-back move fence so detail can restore the prior project", () => {
    const authority = new SessionChannelProjectionAuthority();
    const listOwner = {};
    const moveOwner = {};
    const optimistic = {
      ...session(false, 0),
      channelId: "00000000-0000-4000-8000-000000000202",
    } as Session;
    const staleRoute = {
      ...optimistic,
      channelId: "00000000-0000-4000-8000-000000000201",
      status: "running",
    } as Session;
    let overrides = beginSessionChannelMove(
      new Map(),
      optimistic.id,
      optimistic.channelId ?? null,
      1,
    );
    authority.replace(listOwner, [staleRoute]);
    authority.replace(
      moveOwner,
      [...overrides].map(([id, override]) => ({
        id,
        workspaceId: optimistic.workspaceId,
        channelId: override.channelId,
      })),
      1,
    );

    expect(
      mergeSessionContextProjection(optimistic, staleRoute, authority, "live")?.channelId,
    ).toBe(optimistic.channelId);

    overrides = rollbackSessionChannelMove(overrides, optimistic.id, 1);
    authority.replace(
      moveOwner,
      [...overrides].map(([id, override]) => ({
        id,
        workspaceId: optimistic.workspaceId,
        channelId: override.channelId,
      })),
      1,
    );
    const afterRollback = mergeSessionContextProjection(
      optimistic,
      staleRoute,
      authority,
      "detail",
    );
    expect(afterRollback?.channelId).toBe(staleRoute.channelId);
    expect(
      mergeSessionContextProjection(
        afterRollback,
        { ...staleRoute, channelId: "00000000-0000-4000-8000-000000000204" },
        authority,
        "detail",
      )?.channelId,
    ).toBe(staleRoute.channelId);
  });

  test("bounds route and rail reconciliation after an optimistic pin", async () => {
    const staleDetail = session(false, 0);
    const authoritativeRail = session(true, 1);
    let renders = 0;
    let writes = 0;

    function Probe() {
      const [current, setCurrent] = useState<Session | null>(staleDetail);
      renders += 1;

      useEffect(() => {
        if (!current) return;
        writes += 1;
        const routeProjection = { ...staleDetail, effectiveControl: { ...effectiveControl } };
        setCurrent((previous) => {
          const next = mergeSessionContextProjection(
            previous,
            routeProjection,
            new SessionChannelProjectionAuthority(),
            "live",
          );
          return !next || sameSessionForContext(previous, next) ? previous : next;
        });
      }, [current]);
      useEffect(() => {
        if (!current) return;
        writes += 1;
        const railProjection = {
          ...authoritativeRail,
          effectiveControl: { ...effectiveControl },
        };
        setCurrent((previous) => {
          const next = applySessionPinProjection(previous, railProjection) ?? previous;
          return sameSessionForContext(previous, next) ? previous : next;
        });
      }, [current]);

      return createElement("output", { "data-pinned": String(current?.pinned) });
    }

    const rendered = await renderComponent(createElement(Probe));

    expect(rendered.container.querySelector("output")?.dataset.pinned).toBe("true");
    expect(renders).toBeLessThanOrEqual(4);
    expect(writes).toBeLessThanOrEqual(8);
    await rendered.unmount();
  });
});
