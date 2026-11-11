import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

// A fixed application layout: the page itself never scrolls. The details
// region does not scroll either; the panel inside it does, as does the record
// list. A second region holds two panels around a static centre, and a third
// holds only a long text field.
const FIXTURE = `<!doctype html><title>Records</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; font: 14px sans-serif; }
  .app { display: flex; height: 100vh; }
  nav { width: 200px; overflow: auto; }
  nav a { display: block; padding: 8px; }
  section { display: flex; flex-direction: column; overflow: hidden; }
  #details { flex: 2; }
  #panel { flex: 1; overflow: auto; }
  #panel label { display: block; margin: 0 0 18px; }
  #split { flex: 1; flex-direction: row; align-items: stretch; }
  #split > div { overflow: auto; }
  #small { width: 60px; }
  #gap { width: 200px; overflow: visible !important; }
  #large { width: 160px; }
  .tall { height: 2000px; }
  #notes { flex: 1; }
  #notes textarea { height: 120px; }
</style>
<div class="app">
  <nav aria-label="Records" id="list"></nav>
  <section id="details" aria-label="Details"><h2>Record 7</h2><div id="panel"></div></section>
  <section id="split" aria-label="Split"><div id="small"><div class="tall">small</div></div><div id="gap">centre</div><div id="large"><div class="tall">large</div></div></section>
  <section id="notes" aria-label="Notes"><textarea aria-label="Body"></textarea></section>
</div>
<script>
  for (let i = 1; i <= 60; i++) {
    const a = document.createElement("a");
    a.href = "#" + i;
    a.textContent = "Record " + i;
    list.append(a);
  }
  for (let i = 1; i <= 30; i++) {
    const label = document.createElement("label");
    label.textContent = "Field " + i + " ";
    label.append(Object.assign(document.createElement("input"), { value: "value " + i }));
    panel.append(label);
  }
  document.querySelector("textarea").value = "line\\n".repeat(200);
</script>`;

function flatten(nodes: readonly InteractionSemanticNodeValue[]): InteractionSemanticNodeValue[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function scrollStates(observation: BrowserObservation): Array<[string, string, string]> {
  if (observation.semantic?.kind !== "snapshot") return [];
  return flatten(observation.semantic.roots).flatMap((node) => {
    const state = node.states.find((entry) => entry.startsWith("scrollable="));
    if (!state) return [];
    expect(node.actions).toContain("scroll");
    return [[node.role, node.name ?? "", state] as [string, string, string]];
  });
}

e2e(
  "scrolling a fixed region moves the panel inside it, and the outline marks scrolling panels",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-nested-scroll-");
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
      actor: { kind: "human", subjectId: "nested-scroll-fixture" },
      observationMode: "none",
      action,
    });
    try {
      const initial = await driver.start(`data:text/html,${encodeURIComponent(FIXTURE)}`);
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
      const positions = () =>
        evaluate("[panel.scrollTop, list.scrollTop, small.scrollTop, large.scrollTop, scrollY]");

      // The outline marks the list and the panels, in page order, and not the
      // page, the regions or the text field.
      expect(scrollStates(initial)).toEqual([
        ["navigation", "Records", "scrollable=down"],
        ["generic", "", "scrollable=down"],
        // The narrow panel's label is wider than the panel.
        ["generic", "", "scrollable=down,right"],
        ["generic", "", "scrollable=down"],
      ]);

      // The details region itself cannot scroll and neither can the page:
      // the panel under the region's centre moves.
      const details = { kind: "role", role: "region", name: "Details", exact: true } as const;
      const down = await controller.run(
        command(initial, { type: "scroll", locator: details, deltaX: 0, deltaY: 400 }),
      );
      expect(down.error ?? null).toBeNull();
      expect(down.state).toBe("completed");
      expect(await positions()).toEqual([400, 0, 0, 0, 0]);

      // The outline now says the panel scrolls both ways.
      const after = await driver.observe(initial.target.id);
      expect(scrollStates(after)).toContainEqual(["generic", "", "scrollable=up,down"]);

      // The panel's ref scrolls it directly, back to the top.
      const panel = flatten(after.semantic?.kind === "snapshot" ? after.semantic.roots : []).find(
        (node) => node.states.includes("scrollable=up,down"),
      )!;
      const up = await controller.run(
        command(after, {
          type: "scroll",
          locator: { kind: "ref", ref: panel.ref },
          deltaX: 0,
          deltaY: -1000,
        }),
      );
      expect(up.state).toBe("completed");
      expect(await positions()).toEqual([0, 0, 0, 0, 0]);

      // A region whose centre is over no panel scrolls its largest visible panel.
      const split = { kind: "role", role: "region", name: "Split", exact: true } as const;
      const largest = await controller.run(
        command(after, { type: "scroll", locator: split, deltaX: 0, deltaY: 300 }),
      );
      expect(largest.state).toBe("completed");
      expect(await positions()).toEqual([0, 0, 0, 300, 0]);

      // A text field is not a panel: a region holding only one still refuses,
      // definitely and without moving anything.
      const notes = { kind: "role", role: "region", name: "Notes", exact: true } as const;
      const refused = await controller.run(
        command(after, { type: "scroll", locator: notes, deltaX: 0, deltaY: 300 }),
      );
      expect(refused.state).toBe("failed");
      expect(refused.error?.code).toBe("invalid_action");
      expect(refused.error?.message).toContain("scroll further");
      expect(await evaluate("document.querySelector('textarea').scrollTop")).toBe(0);

      // A page scroll on a page that cannot scroll moves the panel under the
      // viewport's centre.
      const page = await controller.run(command(after, { type: "scroll", deltaX: 0, deltaY: 200 }));
      expect(page.state).toBe("completed");
      expect(await positions()).toEqual([200, 0, 0, 300, 0]);

      // With that panel at its end, a page scroll refuses instead of moving
      // another panel elsewhere on the page.
      await evaluate("panel.scrollTop = panel.scrollHeight");
      const panelEnd = await evaluate("panel.scrollTop");
      const pageEnd = await controller.run(
        command(after, { type: "scroll", deltaX: 0, deltaY: 200 }),
      );
      expect(pageEnd.state).toBe("failed");
      expect(pageEnd.error?.code).toBe("invalid_action");
      expect(await positions()).toEqual([panelEnd, 0, 0, 300, 0]);

      // Once nothing inside the region can move further, it refuses again.
      const bottom = await controller.run(
        command(after, { type: "scroll", locator: details, deltaX: 0, deltaY: 400 }),
      );
      expect(bottom.state).toBe("failed");
      expect(bottom.error?.code).toBe("invalid_action");

      // When the page can scroll a little too, the panel under the region's
      // centre still comes first, as it would for a wheel there.
      await evaluate(`
        panel.scrollTop = 0;
        document.documentElement.style.overflow = "auto";
        document.body.style.overflow = "visible";
        document.body.style.height = "auto";
        document.body.append(Object.assign(document.createElement("div"), { style: "height:50px" }));
      `);
      expect(await evaluate("document.scrollingElement.scrollHeight - innerHeight")).toBe(50);
      const wheelOrder = await controller.run(
        command(after, { type: "scroll", locator: details, deltaX: 0, deltaY: 100 }),
      );
      expect(wheelOrder.state).toBe("completed");
      expect(await positions()).toEqual([100, 0, 0, 300, 0]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

// A documentation page: the page scrolls, beside a sticky sidebar that
// scrolls on its own, and the article holds one short code panel near its top.
const DOCS_FIXTURE = `<!doctype html><title>Docs</title>
<style>
  body { margin: 0; display: flex; font: 14px sans-serif; }
  #sidebar { position: sticky; top: 0; width: 220px; height: 100vh; overflow-y: auto; flex: none; }
  #sidebar a { display: block; padding: 8px; }
  main { flex: 1; padding: 0 16px; }
  main p { margin: 0 0 16px; }
  pre { max-height: 120px; overflow: auto; }
</style>
<nav id="sidebar" aria-label="Contents"></nav>
<main><h1>Guide</h1><pre id="code"></pre><div id="article"></div></main>
<script>
  for (let i = 1; i <= 80; i++) {
    const a = document.createElement("a");
    a.href = "#" + i;
    a.textContent = "Section " + i;
    sidebar.append(a);
  }
  code.textContent = "line\\n".repeat(60);
  for (let i = 1; i <= 120; i++) {
    const p = document.createElement("p");
    p.textContent = "Paragraph " + i + " of the guide.";
    article.append(p);
  }
</script>`;

e2e(
  "a page that can scroll but is at its end refuses, and never moves a panel instead",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-nested-scroll-");
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
      actor: { kind: "human", subjectId: "nested-scroll-fixture" },
      observationMode: "none",
      action,
    });
    try {
      const initial = await driver.start(`data:text/html,${encodeURIComponent(DOCS_FIXTURE)}`);
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
      const positions = () => evaluate("[scrollY, sidebar.scrollTop, code.scrollTop]");
      const end = Number(await evaluate("document.scrollingElement.scrollHeight - innerHeight"));
      expect(end).toBeGreaterThan(400);

      // Away from its end the page scrolls, and nothing else moves.
      const moved = await controller.run(
        command(initial, { type: "scroll", deltaX: 0, deltaY: 300 }),
      );
      expect(moved.state).toBe("completed");
      expect(await positions()).toEqual([300, 0, 0]);

      // At its end a page scroll refuses, again and again, with nothing moved.
      await evaluate(`scrollTo(0, ${end})`);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const atEnd = await controller.run(
          command(initial, { type: "scroll", deltaX: 0, deltaY: 400 }),
        );
        expect(atEnd.state).toBe("failed");
        expect(atEnd.error?.code).toBe("invalid_action");
        expect(await positions()).toEqual([end, 0, 0]);
      }

      // A located scroll on the article refuses too: its page is at its end,
      // and the code panel is not under it on screen.
      const main = { kind: "role", role: "main" } as const;
      const located = await controller.run(
        command(initial, { type: "scroll", locator: main, deltaX: 0, deltaY: 400 }),
      );
      expect(located.state).toBe("failed");
      expect(located.error?.code).toBe("invalid_action");
      expect(await positions()).toEqual([end, 0, 0]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
