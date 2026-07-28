import { describe, expect, test } from "bun:test";
import { createElement, useEffect, useState } from "react";

import { registerDom, renderComponent } from "../../../../packages/react/test/render-hook";
import type { Session } from "@/types";
import { sameSessionForContext } from "./session-context";
import { applySessionPinProjection, mergeSessionContextProjection } from "./session-pins";

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
          const next = mergeSessionContextProjection(previous, routeProjection);
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
