import { describe, expect, test } from "bun:test";
import {
  BrowserTargetResolutionError,
  CurrentBrowserTab,
  expandRefShorthand,
} from "../src/browser-current-tab";

function tabs(
  sessions: Array<{ id: string; lastUsedAt: string }>,
  targets: Record<string, Array<{ id: string; kind: string; selected: boolean }>>,
) {
  const calls: string[] = [];
  const tab = new CurrentBrowserTab({
    listLiveSessions: async () => {
      calls.push("sessions");
      return sessions;
    },
    listTargets: async (id) => {
      calls.push(`targets:${id}`);
      return targets[id] ?? [];
    },
  });
  return { tab, calls };
}

describe("current browser tab", () => {
  test("resolves the most recently used live browser and its selected tab", async () => {
    const { tab, calls } = tabs(
      [
        { id: "b-old", lastUsedAt: "2026-10-16T10:00:00.000Z" },
        { id: "b-new", lastUsedAt: "2026-10-16T11:00:00.000Z" },
      ],
      {
        "b-new": [
          { id: "worker", kind: "worker", selected: false },
          { id: "t-1", kind: "page", selected: false },
          { id: "t-2", kind: "page", selected: true },
        ],
      },
    );
    expect(await tab.target({})).toEqual({
      browserSessionId: "b-new",
      implicit: true,
      targetId: "t-2",
      implicitTarget: true,
    });
    expect(calls).toEqual(["sessions", "targets:b-new"]);
  });

  test("remembers the tab a call used and needs no lookup afterwards", async () => {
    const { tab, calls } = tabs([], {});
    tab.use("b-1", "t-1");
    expect(await tab.target({})).toMatchObject({ browserSessionId: "b-1", targetId: "t-1" });
    tab.use("b-1");
    expect(await tab.target({})).toMatchObject({ browserSessionId: "b-1", targetId: "t-1" });
    tab.use("b-2");
    expect(await tab.session(undefined)).toEqual({ browserSessionId: "b-2", implicit: true });
    expect(calls).toEqual([]);
  });

  test("explicit ids win and a closed or ended tab is forgotten", async () => {
    const { tab } = tabs([], { "b-1": [{ id: "t-5", kind: "page", selected: true }] });
    tab.use("b-1", "t-1");
    expect(await tab.target({ targetId: "t-9" })).toMatchObject({
      targetId: "t-9",
      implicitTarget: false,
    });
    tab.forgetTarget("b-1", "t-1");
    expect(await tab.target({})).toMatchObject({ browserSessionId: "b-1", targetId: "t-5" });
    tab.forgetSession("b-1");
    await expect(tab.target({})).rejects.toBeInstanceOf(BrowserTargetResolutionError);
  });

  test("a failed implicit call resolves afresh next time", async () => {
    const { tab, calls } = tabs([{ id: "b-2", lastUsedAt: "2026-10-16T11:00:00.000Z" }], {
      "b-1": [{ id: "t-3", kind: "page", selected: true }],
      "b-2": [{ id: "t-4", kind: "page", selected: true }],
    });
    tab.use("b-1", "t-1");
    tab.failed({ browserSessionId: "b-1", implicit: false, implicitTarget: true });
    expect(await tab.target({})).toMatchObject({ browserSessionId: "b-1", targetId: "t-3" });
    tab.failed({ browserSessionId: "b-1", implicit: true });
    expect(await tab.target({})).toMatchObject({ browserSessionId: "b-2", targetId: "t-4" });
    expect(calls).toEqual(["targets:b-1", "sessions", "targets:b-2"]);
  });

  test("names what to pass when it cannot choose", async () => {
    const none = tabs([], {}).tab;
    await expect(none.target({})).rejects.toMatchObject({ code: "browser_session_required" });
    const ambiguous = tabs([{ id: "b-1", lastUsedAt: "2026-10-16T11:00:00.000Z" }], {
      "b-1": [
        { id: "t-1", kind: "page", selected: false },
        { id: "t-2", kind: "page", selected: false },
      ],
    }).tab;
    await expect(ambiguous.target({})).rejects.toMatchObject({
      code: "browser_target_required",
      message: expect.stringContaining("2 tabs"),
    });
  });

  test("expands bare ref locators, including inside batches", () => {
    expect(expandRefShorthand({ type: "click", locator: "e1" })).toEqual({
      type: "click",
      locator: { kind: "ref", ref: "e1" },
    });
    expect(
      expandRefShorthand({
        type: "batch",
        actions: [
          { type: "drag", from: "e2", to: "e3" },
          { type: "fill", locator: { kind: "label", text: "Name" }, value: "x" },
        ],
      }),
    ).toEqual({
      type: "batch",
      actions: [
        { type: "drag", from: { kind: "ref", ref: "e2" }, to: { kind: "ref", ref: "e3" } },
        { type: "fill", locator: { kind: "label", text: "Name" }, value: "x" },
      ],
    });
    const untouched = { type: "press", key: "Enter" };
    expect(expandRefShorthand(untouched)).toBe(untouched);
  });
});
