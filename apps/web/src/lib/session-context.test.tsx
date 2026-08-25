import { describe, expect, test } from "bun:test";
import { createElement, useEffect, useState } from "react";

import { registerDom, renderComponent } from "../../../../packages/react/test/render-hook";
import type { Session } from "@/types";
import { sameSessionForContext } from "./session-context";
import {
  applySessionPinProjection,
  mergeSessionContextProjection,
  SessionChannelProjectionAuthority,
} from "./session-pins";
import { beginSessionChannelMove, rollbackSessionChannelMove } from "./session-channel-move";

registerDom();

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

  test("releases a rolled-back move fence so detail can restore the prior project", () => {
    const authority = new SessionChannelProjectionAuthority();
    const owner = {};
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
    authority.replace(
      owner,
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
      owner,
      [...overrides].map(([id, override]) => ({
        id,
        workspaceId: optimistic.workspaceId,
        channelId: override.channelId,
      })),
      1,
    );
    expect(
      mergeSessionContextProjection(optimistic, staleRoute, authority, "detail")?.channelId,
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
