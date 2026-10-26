import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const LONG = "Quarterly handoff reference for the printable export of the east wing project";

// A split view: a folder tree in a fixed-width side panel that clips its
// rows, and the file list beside it. Long rows run past the panel's edge, so
// their centers lie over the file list, which the panel's clip leaves on top
// there. Every row still shows its start, which is where a person clicks.
const FIXTURE = `data:text/html,${encodeURIComponent(
  [
    "<!doctype html><title>Folders</title>",
    "<style>",
    "body{margin:0;font:14px sans-serif}",
    "#split{display:flex;height:100vh}",
    "#side{flex:0 0 260px;overflow:hidden}",
    "#scroller{height:100%;overflow-x:hidden;overflow-y:auto}",
    "[role=treeitem]{display:flex;width:max-content;min-width:100%;white-space:nowrap;line-height:28px;cursor:pointer}",
    "#files{flex:1;background:#f4f4f4}",
    "#menu{position:fixed;left:0;top:0;width:280px;height:100vh;background:#fff}",
    "</style>",
    // Above the tree, a pinned row in a strip that clips without scrolling,
    // indented wholly past the panel's edge.
    '<div id="split"><div id="side"><div style="overflow:clip"><div role="treeitem" id="pinned" aria-level="1" tabindex="-1" style="padding-left:300px"><span>Past the edge</span></div></div>',
    '<div id="scroller"><div role="tree" aria-label="Folders">',
    '<div role="treeitem" id="exports" aria-level="1" aria-expanded="false" tabindex="0" style="padding-left:8px"><span><span>Exports</span></span></div>',
    '<div role="group" id="children" hidden>',
    `<div role="treeitem" id="year" aria-level="2" tabindex="-1" style="padding-left:24px"><span><span>2026 ${LONG}</span></span></div>`,
    "</div>",
    `<div role="treeitem" id="handoff" aria-level="1" tabindex="-1" style="padding-left:8px"><span><span>${LONG}</span></span></div>`,
    "</div></div></div>",
    '<div role="group" aria-label="Files" id="files"><nav><button>Files</button></nav></div></div>',
    "<script>",
    "globalThis.log=[];",
    'document.getElementById("files").addEventListener("click",()=>log.push("FILES"));',
    'for (const row of document.querySelectorAll("[role=treeitem]")) row.addEventListener("click",(event)=>{event.stopPropagation();log.push(row.id)});',
    'document.getElementById("exports").addEventListener("click",()=>{const children=document.getElementById("children");children.hidden=!children.hidden;document.getElementById("exports").setAttribute("aria-expanded",String(!children.hidden))});',
    "</script>",
  ].join(""),
)}`;

e2e(
  "a tree row that runs past its panel's clipped edge is clicked where it shows; a real cover still refuses",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-clipped-panel-click-");
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
      actor: { kind: "human", subjectId: "clipped-panel-click-fixture" },
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
      const click = async (action: BrowserActionCommand["action"]) =>
        await controller.run(command(await driver.observe(initial.target.id), action));
      const treeitem = (name: string) =>
        ({ kind: "role", role: "treeitem", name, exact: true }) as const;

      // The row's center is over the file list, but its start shows in the
      // panel. Both the row and its label text take the click there.
      expect(
        await evaluate(
          'const r = document.getElementById("handoff").getBoundingClientRect(); r.left + r.width / 2 > 260',
        ),
      ).toBe(true);
      const row = await click({ type: "click", locator: treeitem(LONG) });
      expect(row.error ?? null).toBeNull();
      expect(row.state).toBe("completed");
      const text = await click({
        type: "click",
        locator: { kind: "text", text: LONG, exact: true },
      });
      expect(text.error ?? null).toBeNull();
      expect(text.state).toBe("completed");
      expect(await evaluate("log")).toEqual(["handoff", "handoff"]);

      // A freshly expanded child, indented further, works the same way.
      const expand = await click({ type: "click", locator: treeitem("Exports") });
      expect(expand.state).toBe("completed");
      const child = await click({ type: "click", locator: treeitem(`2026 ${LONG}`) });
      expect(child.error ?? null).toBeNull();
      expect(child.state).toBe("completed");
      expect(await evaluate("log")).toEqual(["handoff", "handoff", "exports", "year"]);

      // Wholly past the panel's edge: nothing of it shows, so it is refused
      // with the reason, and the file list beside it is not clicked.
      const past = await click({
        type: "click",
        locator: { kind: "text", text: "Past the edge", exact: true },
      });
      expect(past.state).toBe("failed");
      expect(past.error?.message).toBe(
        "browser element is out of view: it lies past the clipped edge of a panel or container that holds it; scroll that panel to it, or use another control",
      );

      // A menu over the panel covers the part of the row that shows: that is
      // a real cover, so the click is refused, naming the menu.
      await evaluate(
        'document.body.insertAdjacentHTML("beforeend", \'<div id="menu" role="menu" aria-label="Folder actions"></div>\')',
      );
      const covered = await click({ type: "click", locator: treeitem(LONG) });
      // Scrolling the row back into view moved the tree, so the refusal is an
      // unknown outcome that carries the reason.
      expect(covered.state).toBe("outcome_unknown");
      expect(covered.error?.message).toContain(
        '(invalid_action: browser element is covered by menu "Folder actions" where it shows)',
      );
      expect(await evaluate("log")).toEqual(["handoff", "handoff", "exports", "year"]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
