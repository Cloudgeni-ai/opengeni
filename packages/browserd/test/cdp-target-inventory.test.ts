import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AgentBrowserDriver, type BrowserCdpConnection } from "../src";

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

function inventoryFixture(failInventory = false) {
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
        return { targetInfos: [...pages.values()] } as T;
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
  });
  Object.assign(driver, { connection, browserContextId: "owned-context" });
  return { driver, calls, browserSessionId };
}
