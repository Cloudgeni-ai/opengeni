import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AgentBrowserDriver, type BrowserCdpConnection } from "../src";
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
    // Any other missing tab keeps the plain answer.
    await expect(fixture.driver.observe("never-seen")).rejects.toThrow(
      /^browser target does not exist$/u,
    );
  } finally {
    await fixture.driver.close();
  }
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
    navigated = false;
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
