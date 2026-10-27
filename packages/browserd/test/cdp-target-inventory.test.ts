import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { InteractionOutcomeUnknownDriverError } from "@opengeni/interaction";
import { AgentBrowserDriver, CdpTransportError, type BrowserCdpConnection } from "../src";
import { goneBrowserTargetMessage } from "../src/cdp-driver";
import type { OwnedTabsState } from "../src/attached-tab-ledger";

test("metadata-only tab opening returns owned navigated inventory without scanning accessibility", async () => {
  const fixture = inventoryFixture();
  try {
    const targets = await fixture.driver.openTargetWithInventory(
      "https://navigation.example.test/start",
    );
    expect(targets.map((target) => target.id)).toEqual(["prior", "opened-1"]);
    const opened = targets[1]!;
    expect(opened).toMatchObject({
      browserSessionId: fixture.browserSessionId,
      controllerGeneration: "synthetic-controller",
      url: "https://redirect.example.test/final",
      selected: true,
      attached: true,
    });
    expect(opened.targetGeneration).not.toBe("");
    expect(opened.documentGeneration).not.toBeNull();
    expect(targets[0]?.selected).toBe(false);
    expect(
      fixture.calls.filter((call) => call.method === "Accessibility.getFullAXTree"),
    ).toHaveLength(0);
    expect(fixture.calls.filter((call) => call.method === "Target.createTarget")).toEqual([
      {
        method: "Target.createTarget",
        params: { browserContextId: "owned-context", url: "about:blank", background: true },
      },
    ]);
    expect(fixture.calls.some((call) => call.method === "Target.activateTarget")).toBe(false);
    const observation = await fixture.driver.observe(opened.id);
    expect(observation.target).toEqual(opened);
    if (observation.semantic?.kind !== "snapshot") throw new Error("expected semantic snapshot");
    expect(observation.semantic.nodeCount).toBe(1);
    expect(observation.semantic.roots[0]?.ref).toBeString();
    expect(
      fixture.calls.filter((call) => call.method === "Accessibility.getFullAXTree"),
    ).toHaveLength(1);
    const defaultOpen = await fixture.driver.openTarget("https://navigation.example.test/other");
    if (defaultOpen.semantic?.kind !== "snapshot")
      throw new Error("expected default semantic snapshot");
    expect(defaultOpen.semantic.nodeCount).toBe(1);
    expect(
      fixture.calls.filter((call) => call.method === "Accessibility.getFullAXTree"),
    ).toHaveLength(2);
  } finally {
    await fixture.driver.detach();
  }
});

test("a post-creation inventory failure never creates a replacement tab or collects page content", async () => {
  const fixture = inventoryFixture(true);
  try {
    await expect(
      fixture.driver.openTargetWithInventory("https://navigation.example.test/start"),
    ).rejects.toThrow("synthetic inventory outcome unavailable");
    expect(fixture.calls.filter((call) => call.method === "Target.createTarget")).toHaveLength(1);
    expect(
      fixture.calls.filter((call) => call.method === "Accessibility.getFullAXTree"),
    ).toHaveLength(0);
    expect(fixture.calls.some((call) => call.method === "Target.closeTarget")).toBe(false);
  } finally {
    await fixture.driver.detach();
  }
});

test("closing a tab returns inventory without it even while the browser still lists it", async () => {
  // Chrome acknowledges Target.closeTarget before Target.getTargets stops
  // listing the tab; a cold or busy browser keeps listing it for a moment.
  const fixture = inventoryFixture(false, 3);
  try {
    const targets = await fixture.driver.closeTarget("prior");
    expect(targets.map((target) => target.id)).toEqual([]);
    const closeIndex = fixture.calls.findIndex((call) => call.method === "Target.closeTarget");
    expect(
      fixture.calls.slice(closeIndex).filter((call) => call.method === "Target.getTargets").length,
    ).toBeGreaterThan(3);
  } finally {
    await fixture.driver.detach();
  }
});

test("a tab close whose connection ends before the tab list is an unknown outcome", async () => {
  const fixture = inventoryFixture(false, 0, {}, true);
  try {
    const failure = await fixture.driver.closeTarget("prior").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InteractionOutcomeUnknownDriverError);
    expect(failure).toMatchObject({ code: "outcome_unknown", retryable: false });
    expect((failure as Error).message).toStartWith("The tab closed, but");
    expect(fixture.calls.filter((call) => call.method === "Target.closeTarget")).toHaveLength(1);
  } finally {
    await fixture.driver.detach().catch(() => undefined);
  }
});

test("closing the driver in the person's browser closes only the blank tabs it opened", async () => {
  const reported: OwnedTabsState[] = [];
  const settledOnClose: boolean[] = [];
  const fixture = inventoryFixture(false, 0, {
    targetLifecycle: "cdp",
    ownedTabs: {
      onChange: (tabs) => reported.push(tabs),
      onClosed: (settled) => {
        settledOnClose.push(settled);
      },
    },
  });
  // The session's own blank tab, another blank tab it opened, and a tab it
  // opened and used.
  await fixture.driver.start();
  await fixture.driver.openTargetWithInventory("about:blank");
  await fixture.driver.openTarget("https://navigation.example.test/used");
  // Each tab is recorded as soon as the browser creates it.
  expect(reported[0]).toEqual({ created: ["opened-1"], selected: null, closedBlank: [] });
  // Any close (an end, an idle release or a controller shutdown) cleans up.
  await fixture.driver.close();
  const closed = fixture.calls
    .filter((call) => call.method === "Target.closeTarget")
    .map((call) => call.params.targetId);
  // The person's own tab (prior) and the used tab stay open.
  expect(closed).toEqual(["opened-1", "opened-2"]);
  expect(settledOnClose).toEqual([true]);
  expect(reported.at(-1)).toEqual({
    created: ["opened-3"],
    selected: "opened-3",
    closedBlank: ["opened-1", "opened-2"],
  });
});

test("a session continuing in the person's browser carries on in the tab it was using", async () => {
  const fixture = inventoryFixture(false, 0, {
    targetLifecycle: "cdp",
    ownedTabs: { previous: { created: [], selected: "prior", closedBlank: [] } },
  });
  try {
    const observation = await fixture.driver.start();
    expect(observation.target.id).toBe("prior");
    expect(observation.target.selected).toBe(true);
    expect(fixture.calls.some((call) => call.method === "Target.createTarget")).toBe(false);
  } finally {
    await fixture.driver.close();
  }
  // It never opened the person's tab, so it never closes it.
  expect(fixture.calls.some((call) => call.method === "Target.closeTarget")).toBe(false);
});

test("a continuing session whose empty tab was closed opens one and names it for the closed tab", async () => {
  const fixture = inventoryFixture(false, 0, {
    targetLifecycle: "cdp",
    ownedTabs: { previous: { created: [], selected: "closed-1", closedBlank: ["closed-1"] } },
  });
  try {
    const observation = await fixture.driver.start();
    expect(observation.target.id).toBe("opened-1");
    await expect(fixture.driver.observe("closed-1")).rejects.toThrow(
      "browser target does not exist: this session closed this empty tab when it last released the browser; its current tab is opened-1",
    );
    // Any other missing tab says how to carry on.
    await expect(fixture.driver.observe("never-seen")).rejects.toThrow(
      /^browser target does not exist: this ID is not one of this browser's tabs; list the current tabs and use one of their IDs$/u,
    );
  } finally {
    await fixture.driver.close();
  }
});

test("a tab this session closed says when it closed and how to carry on", async () => {
  const fixture = inventoryFixture();
  try {
    await fixture.driver.listTargets();
    await fixture.driver.closeTarget("prior");
    await expect(fixture.driver.observe("prior")).rejects.toThrow(
      /^browser target does not exist: this tab was closed at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ by a close-tab call; list the current tabs and use one of their IDs$/u,
    );
    // A controller reading the tab directly learns the same, not just "missing".
    await expect(fixture.driver.target("prior")).rejects.toThrow("by a close-tab call");
    expect(await fixture.driver.target("never-seen")).toBeNull();
  } finally {
    await fixture.driver.detach();
  }
});

test("tabs a relaunched browser reopened keep their IDs; a tab that did not reopen says why", async () => {
  const fixture = inventoryFixture();
  try {
    fixture.driver.noteRelaunchedTabs({
      reason: "idle_release",
      idleReleaseMinutes: 10,
      tabs: [
        { targetId: "old-prior", replacementId: "prior" },
        { targetId: "old-unmatched", replacementId: null },
      ],
    });
    // The reopened tab is listed, read and acted on under its earlier ID; the
    // browser's new ID for it never reaches a caller.
    expect((await fixture.driver.listTargets()).map((target) => target.id)).toEqual(["old-prior"]);
    expect((await fixture.driver.observe("old-prior")).target.id).toBe("old-prior");
    expect((await fixture.driver.targetState("old-prior")).targetId).toBe("old-prior");
    expect((await fixture.driver.target("old-prior"))?.id).toBe("old-prior");
    expect(fixture.driver.adoptedTabIds()).toEqual([
      { tabId: "old-prior", browserTargetId: "prior" },
    ]);
    const failure = await fixture.driver
      .captureScreenshot("old-unmatched")
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "target_not_found",
      message:
        "browser target does not exist: this browser was stopped after going unused for 10 minutes and relaunched on its next call, and this tab was replaced: no reopened tab could be matched to it, so its page may be open under a new ID and unsaved page input may be lost; list the current tabs and use one of their IDs",
    });
    // Closing the reopened tab closes the browser's tab, and its ID then
    // reads as closed.
    expect(await fixture.driver.closeTarget("old-prior")).toEqual([]);
    expect(
      fixture.calls.filter((call) => call.method === "Target.closeTarget").at(-1)?.params,
    ).toEqual({ targetId: "prior" });
    await expect(fixture.driver.observe("old-prior")).rejects.toThrow(
      /^browser target does not exist: this tab was closed at .* by a close-tab call;/u,
    );
    expect(fixture.driver.adoptedTabIds()).toEqual([]);
  } finally {
    await fixture.driver.detach();
  }
});

test("a tab takes an earlier ID only when neither ID already belongs to another tab", async () => {
  const fixture = inventoryFixture();
  try {
    await fixture.driver.listTargets();
    await fixture.driver.openTargetWithInventory("about:blank");
    fixture.driver.adoptTabIds([
      // The ID names another open tab.
      { tabId: "opened-1", browserTargetId: "prior" },
      { tabId: "earlier", browserTargetId: "prior" },
      // The tab already took an earlier ID; so did this ID.
      { tabId: "earliest", browserTargetId: "prior" },
      { tabId: "earlier", browserTargetId: "opened-1" },
    ]);
    expect((await fixture.driver.listTargets()).map((target) => target.id)).toEqual([
      "earlier",
      "opened-1",
    ]);
    expect(fixture.driver.adoptedTabIds()).toEqual([
      { tabId: "earlier", browserTargetId: "prior" },
    ]);
    // Every result names the tab by the ID callers hold.
    const observation = await fixture.driver.observe("earlier");
    expect(observation.target.id).toBe("earlier");
    expect(
      fixture.calls.some(
        (call) => call.method === "Target.attachToTarget" && call.params.targetId === "earlier",
      ),
    ).toBe(false);
    expect(fixture.driver.readClipboard().sourceTargetId).toBeNull();
  } finally {
    await fixture.driver.detach();
  }
});

test("a missing tab's answer says why it is gone for every known cause", () => {
  expect(goneBrowserTargetMessage(null)).toBe(
    "browser target does not exist: this ID is not one of this browser's tabs; list the current tabs and use one of their IDs",
  );
  expect(
    goneBrowserTargetMessage({ kind: "closed", at: "2026-01-02T03:04:05Z", byCloseCall: false }),
  ).toBe(
    "browser target does not exist: this tab was closed at 2026-01-02T03:04:05Z by its page, or by a person or agent using this browser; list the current tabs and use one of their IDs",
  );
  const relaunched = (reason: "controller_restart" | "browser_lost" | "state_capture") =>
    goneBrowserTargetMessage({ kind: "relaunched", reason });
  expect(relaunched("controller_restart")).toBe(
    "browser target does not exist: this browser stopped when its controller restarted (or while unused afterwards) and was relaunched on its next call, and this tab was replaced: no reopened tab could be matched to it, so its page may be open under a new ID and unsaved page input may be lost; list the current tabs and use one of their IDs",
  );
  expect(relaunched("browser_lost")).toBe(
    "browser target does not exist: this browser's process ended unexpectedly (a crash, or the system or a person ended it) and was relaunched, and this tab was replaced: no reopened tab could be matched to it, so its page may be open under a new ID and unsaved page input may be lost; list the current tabs and use one of their IDs",
  );
  expect(relaunched("state_capture")).toBe(
    "browser target does not exist: this browser restarted to save its profile state, and this tab was replaced: no reopened tab could be matched to it, so its page may be open under a new ID and unsaved page input may be lost; list the current tabs and use one of their IDs",
  );
  expect(
    goneBrowserTargetMessage({
      kind: "relaunched",
      reason: "idle_release",
      idleReleaseMinutes: 1,
    }),
  ).toStartWith(
    "browser target does not exist: this browser was stopped after going unused for 1 minute and",
  );
  // The runtime recognises a missing tab by this prefix.
  expect(goneBrowserTargetMessage(null)).toMatch(/(?:^|: )browser target does not exist\b/u);
});

test("a managed browser's end never closes tabs one by one", async () => {
  const fixture = inventoryFixture();
  try {
    await fixture.driver.openTargetWithInventory("about:blank");
    await fixture.driver.closeUnusedOwnedTabs();
    expect(fixture.calls.some((call) => call.method === "Target.closeTarget")).toBe(false);
  } finally {
    await fixture.driver.detach();
  }
});

function inventoryFixture(
  failInventory = false,
  closedTabListings = 0,
  driverOptions: Partial<ConstructorParameters<typeof AgentBrowserDriver>[0]> = {},
  connectionEndsAfterClose = false,
) {
  const browserSessionId = randomUUID();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const pages = new Map([
    [
      "prior",
      {
        targetId: "prior",
        type: "page",
        title: "Prior",
        url: "https://prior.example.test/",
        browserContextId: "owned-context",
      },
    ],
    [
      "foreign",
      {
        targetId: "foreign",
        type: "page",
        title: "Other",
        url: "https://other.example.test/",
        browserContextId: "other-context",
      },
    ],
  ]);
  let created = 0,
    navigated = false,
    closed = false;
  const closing = new Map<string, number>();
  const connection: BrowserCdpConnection = {
    async send<T>(
      method: string,
      params: Record<string, unknown> = {},
      options?: Parameters<BrowserCdpConnection["send"]>[2],
    ): Promise<T> {
      calls.push({ method, params });
      if (method === "Target.createTarget") {
        const targetId = `opened-${++created}`;
        pages.set(targetId, {
          targetId,
          type: "page",
          title: "Opened",
          url: "about:blank",
          browserContextId: "owned-context",
        });
        return { targetId } as T;
      }
      if (method === "Target.getTargets") {
        if (failInventory && navigated) throw new Error("synthetic inventory outcome unavailable");
        if (connectionEndsAfterClose && closed) throw new CdpTransportError("connection closed");
        const targetInfos = [...pages.values()];
        for (const [targetId, remaining] of closing) {
          if (remaining <= 0) {
            pages.delete(targetId);
            closing.delete(targetId);
          } else closing.set(targetId, remaining - 1);
        }
        return { targetInfos } as T;
      }
      if (method === "Target.closeTarget") {
        const targetId = String(params.targetId);
        closed = true;
        if (closedTabListings > 0) closing.set(targetId, closedTabListings - 1);
        else pages.delete(targetId);
        return { success: true } as T;
      }
      if (method === "Target.attachToTarget") return { sessionId: params.targetId } as T;
      const page = pages.get(options?.sessionId ?? "");
      if (method === "Page.navigate") {
        page!.url = "https://redirect.example.test/final";
        navigated = true;
        return {} as T;
      }
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: {
              id: "frame-1",
              loaderId: navigated ? "navigated-loader" : "blank-loader",
              url: page!.url,
            },
          },
        } as T;
      }
      if (method === "Runtime.evaluate") return { result: { value: "complete" } } as T;
      if (method === "Accessibility.getFullAXTree")
        return {
          nodes: [
            {
              nodeId: "node-1",
              backendDOMNodeId: 1,
              role: { value: "button" },
              name: { value: "Submit" },
            },
          ],
        } as T;
      return {} as T;
    },
    on: () => () => {},
    waitForEvent: async () => {
      throw new Error("unexpected fixture event wait");
    },
    close() {},
  };
  const driver = new AgentBrowserDriver({
    browserSessionId,
    controllerGeneration: "synthetic-controller",
    runner: { run: async <T>() => ({}) as T },
    ...driverOptions,
  });
  Object.assign(driver, { connection, browserContextId: "owned-context" });
  return { driver, calls, browserSessionId };
}
