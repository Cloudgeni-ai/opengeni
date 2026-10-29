import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAction, BrowserActionCommand } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

// A background tab is hidden only in a windowed (headed) browser.
const e2e = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1" ? test : test.skip;

const PAGE =
  '<!doctype html><title>Hidden tab click</title><button id="go" style="margin:40px;width:160px;height:48px">Go</button><script>globalThis.seen=[];for(const type of ["pointermove","pointerdown","mousedown","pointerup","mouseup","click"])go.addEventListener(type,(event)=>seen.push(event.type));</script>';

/** Clicks a button in a tab hidden behind another and returns each click's
 * outcome. The tab was opened in the background, or was in front until
 * another tab was brought over it (`shownFirst`). */
async function clickHiddenTab(options: {
  failCaptures: boolean;
  shownFirst?: boolean;
}): Promise<string[]> {
  // Served over HTTP like a real site: Chromium draws a data: URL tab opened
  // in the background, but not a page loaded from a site.
  const pages = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }),
  });
  const directory = await mkdtemp("/tmp/ogb-hidden-tab-click-");
  const browserSessionId = randomUUID();
  const controllerGeneration = `controller-${randomUUID()}`;
  const runner = await ManagedBrowserRunner.create({
    profileDirectory: join(directory, "profile"),
    headed: true,
    ...(process.env.OPENGENI_BROWSER_EXECUTABLE
      ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
      : {}),
  });
  // No focus emulation: the fallback for a browser or extension without it.
  let failCaptures = false;
  const driver = new AgentBrowserDriver({
    browserSessionId,
    controllerGeneration,
    runner,
    connect: async (endpoint) => {
      const connection = await CdpConnection.connect(endpoint);
      const send = connection.send.bind(connection);
      // Stands in for a tab whose captures keep failing.
      connection.send = ((method, params, sendOptions) =>
        failCaptures && method === "Page.captureScreenshot"
          ? Promise.reject(new Error("Unable to capture screenshot"))
          : send(method, params, sendOptions)) as typeof connection.send;
      return connection;
    },
  });
  const controller = new BrowserInteractionController({
    browserSessionId,
    controllerGeneration,
    driver,
  });
  let cdp: CdpConnection | null = null;
  const run = async (tab: string, action: BrowserAction) => {
    // Read the generations without observing: a full observation can
    // capture the tab, which would make it draw.
    const current = await driver.targetState(tab);
    const command: BrowserActionCommand = {
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: tab,
      expectedTargetGeneration: current.targetGeneration,
      expectedDocumentGeneration: current.documentGeneration!,
      expectedFrameId: current.frameId!,
      actor: { kind: "human", subjectId: "hidden-tab-click-fixture" },
      observationMode: "none",
      action,
    };
    return await controller.run(command);
  };
  try {
    let tabId: string;
    if (options.shownFirst) {
      tabId = (await driver.start(`${pages.url.origin}/first`)).target.id;
      const front = (await driver.openTarget(`${pages.url.origin}/front`)).target.id;
      expect((await run(front, { type: "activate" })).state).toBe("completed");
    } else {
      await driver.start(`${pages.url.origin}/front`);
      tabId = (await driver.openTarget(`${pages.url.origin}/first`)).target.id;
    }
    failCaptures = options.failCaptures;
    const outcomes: string[] = [];
    const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
    cdp = await CdpConnection.connect(endpoint.cdpUrl);
    const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: tabId,
      flatten: true,
    });
    const evaluate = async (expression: string) =>
      (
        await cdp!.send<{ result: { value: unknown } }>(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          { sessionId: attached.sessionId },
        )
      ).result.value;
    const clickGo = async (label: string) => {
      // Precondition: the tab really is hidden behind the front one.
      expect(await evaluate("document.visibilityState")).toBe("hidden");
      const result = await run(tabId, {
        type: "click",
        locator: { kind: "css", selector: "#go" },
      });
      const seen = (await evaluate("seen")) as string[];
      console.log(`${label}: ${result.state} ${result.error?.message ?? ""} [${seen}]`);
      outcomes.push(result.state);
      if (result.state === "completed") {
        // Reported done: the page must have had the press and the click.
        expect(seen).toContain("pointerdown");
        expect(seen).toContain("click");
      } else {
        // Otherwise a definite refusal that says why, before any press.
        expect(result.state).toBe("failed");
        expect(result.error?.message).toContain("hidden");
        expect(seen).not.toContain("pointerdown");
        expect(seen).not.toContain("click");
      }
    };

    await clickGo("first document");
    if (options.shownFirst) return outcomes;
    // A new document in the same hidden tab has not drawn either.
    const navigated = await run(tabId, { type: "navigate", url: `${pages.url.origin}/second` });
    expect(navigated.state).toBe("completed");
    expect(await evaluate("location.pathname")).toBe("/second");
    await clickGo("second document");
    return outcomes;
  } finally {
    await cdp?.close();
    await driver.close();
    pages.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

e2e(
  "a click in a hidden background tab without focus emulation reaches the page",
  async () => {
    expect(await clickHiddenTab({ failCaptures: false })).toEqual(["completed", "completed"]);
  },
  120_000,
);

e2e(
  "a hidden tab that cannot be made to draw refuses the click before any press",
  async () => {
    expect(await clickHiddenTab({ failCaptures: true })).toEqual(["failed", "failed"]);
  },
  120_000,
);

e2e(
  "a hidden tab that was shown before takes the click without being made to draw",
  async () => {
    expect(await clickHiddenTab({ failCaptures: true, shownFirst: true })).toEqual(["completed"]);
  },
  120_000,
);
