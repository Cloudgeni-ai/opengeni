import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

// A search form whose results keep replacing their frame once submitted, so
// the page's frame tree never holds still long enough for an outline read.
const RESTLESS_RESULTS = `<!doctype html><title>Search</title>
<form id="search"><input aria-label="Search" name="q"></form>
<div id="results"></div>
<script>
globalThis.searched = [];
document.getElementById("search").addEventListener("submit", (event) => {
  event.preventDefault();
  searched.push(document.querySelector("input").value);
  const results = "<ul>" + "<li><a href=#>result</a></li>".repeat(400) + "</ul>";
  globalThis.churn = setInterval(() => {
    const frame = document.createElement("iframe");
    frame.srcdoc = results;
    document.getElementById("results").replaceChildren(frame);
  }, 10);
});
</script>`;

const NATIVE_DROPDOWN = `<!doctype html><title>Order</title>
<label>Size <select id="size"><option value="s">Small</option><option value="m">Medium</option><option value="l" disabled>Large</option></select></label>
<label>Toppings <select id="toppings" multiple size="3"><option>Cheese</option><option>Olives</option></select></label>
<label>City <input list="cities"></label><datalist id="cities"><option value="Lisbon"></option></datalist>
<script>
globalThis.changes = 0;
document.getElementById("size").addEventListener("change", () => changes++);
</script>`;

async function withBrowser(
  run: (input: {
    driver: AgentBrowserDriver;
    controller: BrowserInteractionController;
    start: (html: string) => Promise<BrowserObservation>;
    command: (
      observation: BrowserObservation,
      action: BrowserActionCommand["action"],
      observationMode?: BrowserActionCommand["observationMode"],
    ) => BrowserActionCommand;
    evaluate: (expression: string) => Promise<unknown>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-dispatch-outcome-");
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
  let sessionId: string | null = null;
  try {
    await run({
      driver,
      controller,
      start: async (html) => {
        const initial = await driver.start(`data:text/html,${encodeURIComponent(html)}`);
        const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
        cdp = await CdpConnection.connect(endpoint.cdpUrl);
        sessionId = (
          await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
            targetId: initial.target.id,
            flatten: true,
          })
        ).sessionId;
        return initial;
      },
      command: (observation, action, observationMode = "full") => ({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId,
        controllerGeneration,
        targetId: observation.target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId!,
        actor: { kind: "human", subjectId: "dispatch-outcome-fixture" },
        observationMode,
        action,
      }),
      evaluate: async (expression) =>
        (
          await cdp!.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            { sessionId: sessionId! },
          )
        ).result.value,
    });
  } finally {
    await (cdp as CdpConnection | null)?.close();
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
}

e2e(
  "actions that ran stay completed when only the outline after them cannot be read",
  async () => {
    await withBrowser(async ({ driver, controller, start, command, evaluate }) => {
      const initial = await start(RESTLESS_RESULTS);
      const search = { kind: "label", text: "Search" } as const;
      const receipt = await controller.run(
        command(initial, {
          type: "batch",
          actions: [
            { type: "fill", locator: search, value: "quarterly report" },
            { type: "press", locator: search, key: "Enter" },
          ],
        }),
      );
      expect(await evaluate("searched")).toEqual(["quarterly report"]);
      expect(receipt.error).toBeNull();
      expect(receipt.state).toBe("completed");
      expect(receipt.observation).toBeNull();
      expect(receipt.notes).toEqual([
        {
          actionIndex: 1,
          kind: "observation_unavailable",
          message: expect.stringContaining("could not be read"),
        },
      ]);
      // The browser was never lost: once the page holds still, it reads as usual.
      await evaluate("clearInterval(churn)");
      const after = await driver.observe(initial.target.id);
      expect(after.target.id).toBe(initial.target.id);
    });
  },
  60_000,
);

e2e(
  "clicking an option of a native dropdown selects it",
  async () => {
    await withBrowser(async ({ driver, controller, start, command, evaluate }) => {
      const initial = await start(NATIVE_DROPDOWN);
      const size = { kind: "role", role: "combobox", name: "Size" } as const;
      const option = (name: string) =>
        ({ kind: "role", role: "option", name, exact: true }) as const;
      // As a person does it: open the dropdown, then pick an option in it.
      const picked = await controller.run(
        command(initial, {
          type: "batch",
          actions: [
            { type: "click", locator: size },
            { type: "click", locator: option("Medium") },
          ],
        }),
      );
      expect(picked.error).toBeNull();
      expect(picked.state).toBe("completed");
      expect(await evaluate('[document.getElementById("size").value, changes]')).toEqual(["m", 1]);
      // The dropdown's list closed, as after a person's choice.
      expect(
        await evaluate(
          '[document.getElementById("size").matches(":open"), document.activeElement.id]',
        ),
      ).toEqual([false, "size"]);

      // The dropdown need not be open: one click on an option chooses it.
      const view = await driver.observe(initial.target.id);
      const direct = await controller.run(
        command(view, { type: "click", locator: option("Small") }, "none"),
      );
      expect(direct.state).toBe("completed");
      expect(await evaluate('[document.getElementById("size").value, changes]')).toEqual(["s", 2]);

      // A disabled option is refused before anything changes.
      const disabled = await controller.run(
        command(view, { type: "click", locator: option("Large") }, "none"),
      );
      expect(disabled.state).toBe("failed");
      expect(disabled.error?.code).toBe("invalid_action");
      expect(await evaluate('[document.getElementById("size").value, changes]')).toEqual(["s", 2]);

      // An option of a list box has its own box and is clicked like any element.
      const listed = await controller.run(
        command(view, { type: "click", locator: option("Olives") }, "none"),
      );
      expect(listed.state).toBe("completed");
      expect(
        await evaluate('[...document.getElementById("toppings").selectedOptions].map(o => o.text)'),
      ).toEqual(["Olives"]);

      // Any other element the page does not render is a definite refusal
      // before input, not a lost browser.
      const suggestion = await controller.run(
        command(
          view,
          { type: "click", locator: { kind: "css", selector: "#cities option" } },
          "none",
        ),
      );
      expect(suggestion.state).toBe("failed");
      expect(suggestion.error).toMatchObject({
        code: "invalid_action",
        message: expect.stringContaining("has no box on the page"),
      });
    });
  },
  60_000,
);
