import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

// A page header that the page slides up as its content panel scrolls: the
// panel is the header's sibling, so scrolling the header's link "into view"
// moves nothing. Its link is still in the page (and the outline) while it is
// partly or wholly above the window.
const FIXTURE = `data:text/html,${encodeURIComponent(
  [
    "<!doctype html><title>Out of view</title>",
    "<style>",
    "body{margin:0}",
    "#column{position:relative;height:100vh;overflow:hidden}",
    "#panel{position:absolute;inset:0;overflow:auto;padding-top:140px}",
    "#header{position:absolute;top:0;left:0;right:0;pointer-events:none}",
    "#crumbs{pointer-events:auto;height:40px}",
    "#crumbs a{display:block;width:120px;line-height:40px}",
    "#card{pointer-events:auto;height:100px;background:#eee}",
    "</style>",
    '<div id="column"><div id="panel">',
    '<button style="pointer-events:none">Ghost</button>',
    '<div style="height:3000px"></div>',
    '</div><div id="header"><nav aria-label="Breadcrumb" id="crumbs"><a href="#list" id="list">List</a></nav><div id="card">Record</div></div></div>',
    "<script>",
    "globalThis.clicks=0;",
    'document.getElementById("list").addEventListener("click",(event)=>{event.preventDefault();clicks++});',
    'const panel=document.getElementById("panel");const header=document.getElementById("header");',
    'panel.addEventListener("scroll",()=>{header.style.transform="translateY("+(-Math.min(panel.scrollTop,40))+"px)"});',
    "</script>",
  ].join(""),
)}`;

e2e(
  "a target partly outside the window is clicked on its visible part; one wholly out of reach says why",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-out-of-view-click-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({ browserSessionId, controllerGeneration, runner });
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver,
    });
    let cdp: CdpConnection | null = null;
    const command = (
      observation: BrowserObservation,
      action: BrowserActionCommand["action"],
    ): BrowserActionCommand => ({
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId!,
      actor: { kind: "human", subjectId: "out-of-view-click-fixture" },
      observationMode: "none",
      action,
    });
    try {
      const initial = await driver.start(FIXTURE);
      const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      cdp = await CdpConnection.connect(endpoint.cdpUrl);
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: initial.target.id,
        flatten: true,
      });
      const evaluate = async (expression: string) =>
        (
          await cdp!.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: true },
            { sessionId: attached.sessionId },
          )
        ).result.value;
      // Scrolls the panel and waits until the header has followed it.
      const scrollPanel = (top: number) =>
        evaluate(
          `panel.scrollTop = ${top}; new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.getElementById("list").getBoundingClientRect().top))))`,
        );
      const list = { kind: "role", role: "link", name: "List", exact: true } as const;
      const click = async (action: BrowserActionCommand["action"]) =>
        await controller.run(command(await driver.observe(initial.target.id), action));

      // The header slid up by 30px: the link's center is above the window
      // and nothing is there, but its lower part still shows. A person
      // clicks that part, and so does the driver.
      expect(await scrollPanel(30)).toBe(-30);
      const partial = await click({ type: "click", locator: list });
      expect(partial.error ?? null).toBeNull();
      expect(partial.state).toBe("completed");
      expect(await evaluate("clicks")).toBe(1);

      // Wholly above the window: nothing is at its center, and nothing
      // scrolled or moved, so the refusal is definite and says what to do.
      expect(await scrollPanel(100)).toBe(-40);
      const outside = await click({ type: "click", locator: list });
      expect(outside.state).toBe("failed");
      expect(outside.error?.code).toBe("invalid_action");
      expect(outside.error?.message).toBe(
        "browser element is out of view: nothing is at its center, which lies outside the window; scroll the page or panel back to it, or use another control",
      );

      // Below a top margin the window still covers the slid-up link, but the
      // column clips it: only the link's own container is there.
      await evaluate(
        'document.body.style.paddingTop = "60px"; document.getElementById("column").style.height = "calc(100vh - 60px)"',
      );
      expect(await scrollPanel(100)).toBe(20);
      const clipped = await click({ type: "click", locator: list });
      // The driver first tries hovering (the pointer moved), so the refusal
      // is an unknown outcome that carries the reason.
      expect(clipped.state).toBe("outcome_unknown");
      expect(clipped.error?.message).toContain(
        "browser element is out of view: only its own container is at its center, where it is clipped or hidden; scroll the page or panel back to it, or use another control",
      );
      expect(await evaluate("clicks")).toBe(1);

      // Scrolled back, the link takes the click at its center as before.
      expect(await scrollPanel(0)).toBe(60);
      const back = await click({ type: "click", locator: list });
      expect(back.state).toBe("completed");
      expect(await evaluate("clicks")).toBe(2);

      // In view but not taking the pointer at all.
      const ghost = await click({
        type: "click",
        locator: { kind: "role", role: "button", name: "Ghost", exact: true },
      });
      expect(ghost.state).toBe("outcome_unknown");
      expect(ghost.error?.message).toContain(
        "browser element does not take pointer input (pointer-events: none); press Enter on it or use another control",
      );
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
