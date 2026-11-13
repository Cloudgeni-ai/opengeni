import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserAction,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

// A list that redraws its rows (an inbox, a feed) replaces the elements a
// ref named with identical ones, without any input from the caller. A ref whose role and name name exactly one
// element, before and after, still acts on it; a repeated one stays stale.
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const page = `<!doctype html><title>Inbox</title>
<ul id="rows"></ul><p id="log">Opened nothing</p><p id="draws">Drawn 0 times</p>
<script>
const rows = document.getElementById("rows");
const draw = () => {
  rows.innerHTML = ["Alice", "Bob"].map((name) =>
    '<li><button data-open="' + name + '">Open mail from ' + name + '</button>' +
    '<button data-archive="' + name + '">Archive</button></li>').join("");
};
let draws = 0;
const redraw = () => {
  draw();
  document.getElementById("draws").textContent = "Drawn " + ++draws + " times";
};
redraw();
// Shortly after loading, the list redraws twice, then holds still.
setTimeout(redraw, 300);
setTimeout(redraw, 400);
rows.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (target) document.getElementById("log").textContent =
    target.dataset.open ? "Opened " + target.dataset.open : "Archived " + target.dataset.archive;
});
</script>`;

e2e(
  "a ref the page redrew acts on the identical element when it is the only one",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(page, { headers: { "content-type": "text/html" } }),
    });
    const directory = await mkdtemp("/tmp/ogb-ref-redrawn-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
    });
    const act = async (observation: BrowserObservation, action: BrowserAction) =>
      await driver.dispatch({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: observation.browserSessionId,
        controllerGeneration: observation.target.controllerGeneration,
        targetId: observation.target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration,
        expectedFrameId: observation.frameId!,
        actor: { kind: "agent", subjectId: "ref-redrawn" },
        action,
      });
    const refOf = (observation: BrowserObservation, name: string) => {
      const found: string[] = [];
      const visit = (item: InteractionSemanticNodeValue): void => {
        if (item.name === name && item.ref) found.push(item.ref);
        for (const child of item.children ?? []) visit(child);
      };
      const semantic = observation.semantic;
      if (semantic?.kind === "snapshot") for (const root of semantic.roots) visit(root);
      if (!found[0]) throw new Error(`no ${name} in the observation`);
      return found[0];
    };
    try {
      const origin = `http://127.0.0.1:${server.port}/`;
      // Read before the redraws, then act once they are done.
      const readBeforeRedraw = async (url: string) => {
        const opened = await driver.openTarget(url);
        const seen = await driver.observe(opened.target.id);
        expect(JSON.stringify(seen)).toContain("Drawn 1 times");
        await Bun.sleep(700);
        return seen;
      };

      const seen = await readBeforeRedraw(origin);
      const opened = await act(seen, {
        type: "click",
        locator: { kind: "ref", ref: refOf(seen, "Open mail from Bob") },
      });
      expect(JSON.stringify(opened)).toContain("Opened Bob");

      // "Archive" is on every row: which one the ref meant is unknown.
      const again = await readBeforeRedraw(`${origin}?again`);
      const failure = await act(again, {
        type: "click",
        locator: { kind: "ref", ref: refOf(again, "Archive") },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(String(failure)).toContain("stale");
      expect(JSON.stringify(await driver.observe(again.target.id))).not.toContain("Archived");
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
