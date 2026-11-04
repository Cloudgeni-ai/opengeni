import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAction, BrowserActionCommand } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

// Tabs hidden behind another tab, in a browser without focus emulation: the
// fallback for a browser or extension where it is unavailable.
const headedE2e = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1" ? test : test.skip;
const headlessE2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const PAGE =
  '<!doctype html><title>Hidden tab click</title><button id="go" style="margin:40px;width:160px;height:48px">Go</button><script>globalThis.seen=[];for(const type of ["pointermove","pointerdown","mousedown","pointerup","mouseup","click"])go.addEventListener(type,(event)=>seen.push(event.type));</script>';

type HiddenTab = {
  tabId: string;
  origin: string;
  run: (action: BrowserAction) => ReturnType<BrowserInteractionController["run"]>;
  evaluate: (expression: string) => Promise<unknown>;
};

/** Opens `/page` in a tab hidden behind another one and runs `use` on it.
 * The tab was opened in the background, or was in front until another tab
 * was brought over it (`shownFirst`). With `failCaptures`, every capture of
 * a tab fails once the tab is open. */
async function withHiddenTab(
  options: { headed: boolean; page: string; failCaptures?: boolean; shownFirst?: boolean },
  use: (tab: HiddenTab) => Promise<void>,
): Promise<void> {
  // Served over HTTP like a real site: Chromium draws a data: URL tab opened
  // in the background, but not a page loaded from a site.
  const pages = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(options.page, { headers: { "content-type": "text/html" } }),
  });
  const origin = pages.url.origin;
  const directory = await mkdtemp("/tmp/ogb-hidden-tab-click-");
  const browserSessionId = randomUUID();
  const controllerGeneration = `controller-${randomUUID()}`;
  const runner = await ManagedBrowserRunner.create({
    profileDirectory: join(directory, "profile"),
    headed: options.headed,
    ...(process.env.OPENGENI_BROWSER_EXECUTABLE
      ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
      : {}),
  });
  let failCaptures = false;
  // No focus emulation.
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
  const runOn = async (tab: string, action: BrowserAction) => {
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
  let cdp: CdpConnection | null = null;
  try {
    let tabId: string;
    if (options.shownFirst) {
      tabId = (await driver.start(`${origin}/page`)).target.id;
      const front = (await driver.openTarget(`${origin}/front`)).target.id;
      expect((await runOn(front, { type: "activate" })).state).toBe("completed");
    } else {
      await driver.start(`${origin}/front`);
      tabId = (await driver.openTarget(`${origin}/page`)).target.id;
    }
    failCaptures = options.failCaptures ?? false;
    const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
    cdp = await CdpConnection.connect(endpoint.cdpUrl);
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: tabId,
      flatten: true,
    });
    const evaluate = async (expression: string) =>
      (
        await cdp!.send<{ result: { value: unknown } }>(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          { sessionId },
        )
      ).result.value;
    // Precondition: the tab really is hidden behind the front one.
    expect(await evaluate("document.visibilityState")).toBe("hidden");
    await use({ tabId, origin, run: async (action) => await runOn(tabId, action), evaluate });
  } finally {
    await (cdp as CdpConnection | null)?.close();
    await driver.close();
    pages.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Clicks "Go" and checks that a completed click reached the page, and that
 * anything else is a refusal that says why, sent before any press. */
async function clickGo(tab: HiddenTab, label: string): Promise<string> {
  expect(await tab.evaluate("document.visibilityState")).toBe("hidden");
  const result = await tab.run({ type: "click", locator: { kind: "css", selector: "#go" } });
  const seen = (await tab.evaluate("seen")) as string[];
  console.log(`${label}: ${result.state} ${result.error?.message ?? ""} [${seen}]`);
  if (result.state === "completed") {
    expect(seen).toContain("pointerdown");
    expect(seen).toContain("click");
  } else {
    expect(result.state).toBe("failed");
    expect(result.error?.message).toContain("hidden");
    expect(seen).not.toContain("pointerdown");
    expect(seen).not.toContain("click");
  }
  return result.state;
}

/** Clicks "Go" on the first document, then on a new document the hidden tab
 * navigated to, which has not drawn either. */
async function clickTwoDocuments(tab: HiddenTab): Promise<string[]> {
  const outcomes = [await clickGo(tab, "first document")];
  const navigated = await tab.run({ type: "navigate", url: `${tab.origin}/second` });
  expect(navigated.state).toBe("completed");
  expect(await tab.evaluate("location.pathname")).toBe("/second");
  outcomes.push(await clickGo(tab, "second document"));
  return outcomes;
}

headedE2e(
  "a click in a hidden background tab without focus emulation reaches the page",
  async () => {
    await withHiddenTab({ headed: true, page: PAGE }, async (tab) => {
      const started = performance.now();
      expect(await clickTwoDocuments(tab)).toEqual(["completed", "completed"]);
      // Without waiting out Chrome's roughly five-second hold of each
      // pointer move sent to a hidden page.
      expect(performance.now() - started).toBeLessThan(5_000);
    });
  },
  120_000,
);

headedE2e(
  "a hidden tab that cannot be made to draw refuses the click before any press",
  async () => {
    await withHiddenTab({ headed: true, page: PAGE, failCaptures: true }, async (tab) => {
      expect(await clickTwoDocuments(tab)).toEqual(["failed", "failed"]);
    });
  },
  120_000,
);

headedE2e(
  "a hidden tab that was shown before takes the click without being made to draw",
  async () => {
    await withHiddenTab(
      { headed: true, page: PAGE, failCaptures: true, shownFirst: true },
      async (tab) => {
        expect(await clickGo(tab, "shown before")).toBe("completed");
      },
    );
  },
  120_000,
);

// Moving the pointer onto "Confirm" keeps the page busy for longer than
// Chrome holds a hidden page's pointer move, and then opens a card over it.
// The press that follows lands on the card, so the click must be refused,
// never reported done.
const busyHoverPage = (event: string, busyMs: number) =>
  `<!doctype html><title>Busy hover card</title><style>body{margin:0}#card{display:none;position:absolute;top:0;left:0;width:300px;height:100px;background:#fff}</style><div style="padding:30px"><button id="target">Confirm</button></div><div id="card" role="dialog" aria-label="Profile card"><button id="follow">Follow</button></div><script>globalThis.clicks={confirm:0,card:0};target.addEventListener("click",()=>clicks.confirm++);card.addEventListener("click",()=>clicks.card++);target.addEventListener("${event}",()=>{const until=performance.now()+${busyMs};while(performance.now()<until){}card.style.display="block"});</script>`;

for (const [mode, e2e] of [
  ["headed", headedE2e],
  ["headless", headlessE2e],
] as const) {
  for (const [event, busyMs] of [
    ["pointermove", 6_500],
    ["pointermove", 12_000],
    ["mouseenter", 6_500],
    ["mouseenter", 12_000],
  ] as const) {
    e2e(
      `a layer that appears after a ${busyMs} ms busy ${event} in a hidden ${mode} tab receives no click`,
      async () => {
        await withHiddenTab(
          { headed: mode === "headed", page: busyHoverPage(event, busyMs) },
          async (tab) => {
            const refused = await tab.run({
              type: "click",
              locator: { kind: "css", selector: "#target" },
            });
            console.log(`${mode} ${event} ${busyMs}: ${refused.state} ${refused.error?.message}`);
            expect(refused.state).not.toBe("completed");
            expect(refused.error?.message).toContain('covered by dialog "Profile card"');
            expect(await tab.evaluate("[clicks.confirm, clicks.card]")).toEqual([0, 0]);
          },
        );
      },
      120_000,
    );
  }

  e2e(
    `a frame that appears over the target as the pointer arrives in a hidden ${mode} tab is not counted as clicked`,
    async () => {
      // The press lands in the frame's own document, where the guard on the
      // target's document cannot see it: the click is not reported done.
      await withHiddenTab(
        {
          headed: mode === "headed",
          page: `<!doctype html><title>Framed cover</title><style>body{margin:0}iframe{display:none;position:absolute;top:0;left:0;width:300px;height:100px;border:0}</style><div style="padding:30px"><button id="target">Confirm</button></div><iframe id="cover" title="Offer" srcdoc="<button>Offer</button>"></iframe><script>globalThis.clicks={confirm:0};target.addEventListener("click",()=>clicks.confirm++);target.addEventListener("mouseenter",()=>{cover.style.display="block"});</script>`,
        },
        async (tab) => {
          const result = await tab.run({
            type: "click",
            locator: { kind: "css", selector: "#target" },
          });
          console.log(`${mode} framed cover: ${result.state} ${result.error?.message}`);
          expect(result.state).not.toBe("completed");
          expect(await tab.evaluate("clicks.confirm")).toBe(0);
        },
      );
    },
    120_000,
  );
}
