import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAction, BrowserActionCommand } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";
import type { BrowserCdpConnection } from "../src/cdp-driver";

// A click's hit-target guard must not outlive the click by much: once the
// agent's click is over, the person's own clicks on the page go through.
// And a click that demonstrably landed is reported done, even on a page that
// stops presses before the guard sees them.
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const buttons =
  '<style>body{margin:0}button{display:block;margin:30px;width:160px;height:48px}#card{display:none;position:absolute;top:0;left:0;width:400px;height:120px;background:#fff}</style><button id="go">Go</button><button id="other">Other</button><div id="card" role="dialog" aria-label="Profile card"></div><script>globalThis.clicks={go:0,other:0,card:0};go.addEventListener("click",()=>clicks.go++);other.addEventListener("click",()=>clicks.other++);card.addEventListener("click",()=>clicks.card++);</script>';

/** "Go" opens an alert as the pointer arrives on it. */
const ALERT_ON_HOVER = `<!doctype html><title>Alert on hover</title>${buttons}<script>go.addEventListener("mouseenter",()=>alert("Hovered"));</script>`;

/** The page stops every press at the window, before any listener added
 * later (as the click's guard is) can see it. */
const stopsPresses = (extra = "") =>
  `<!doctype html><title>Stops presses</title><script>for(const type of ["pointerdown","mousedown"])addEventListener(type,(event)=>event.stopImmediatePropagation(),true);</script>${buttons}${extra}`;

type Fixture = {
  run: (action: BrowserAction) => ReturnType<BrowserInteractionController["run"]>;
  evaluate: (expression: string) => Promise<unknown>;
  /** A person's click at the centre of the element with this id, sent from
   * another connection than the driver's. */
  personClick: (id: string) => Promise<void>;
  /** Answers the open dialog from another connection than the driver's. */
  personAcceptDialog: () => Promise<void>;
};

async function withFixture(
  options: { page: string; driverMissesDialogClose?: boolean },
  use: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const pages = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(options.page, { headers: { "content-type": "text/html" } }),
  });
  const directory = await mkdtemp("/tmp/ogb-interrupted-click-guard-");
  const browserSessionId = randomUUID();
  const controllerGeneration = `controller-${randomUUID()}`;
  const runner = await ManagedBrowserRunner.create({
    profileDirectory: join(directory, "profile"),
    headed: false,
    ...(process.env.OPENGENI_BROWSER_EXECUTABLE
      ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
      : {}),
  });
  const driver = new AgentBrowserDriver({
    browserSessionId,
    controllerGeneration,
    runner,
    // As in managed and attached browsers.
    focusEmulation: true,
    connect: async (endpoint) => {
      const connection = await CdpConnection.connect(endpoint);
      if (!options.driverMissesDialogClose) return connection;
      // Stands in for a dialog that closed without the driver hearing of it.
      const wrapped: BrowserCdpConnection = {
        send: connection.send.bind(connection),
        on: (method, listener, sessionId) =>
          method === "Page.javascriptDialogClosed"
            ? () => undefined
            : connection.on(method, listener, sessionId),
        onDisconnect: connection.onDisconnect.bind(connection),
        onDroppedMessage: connection.onDroppedMessage.bind(connection),
        close: connection.close.bind(connection),
        waitForEvent: connection.waitForEvent.bind(connection),
      };
      return wrapped;
    },
  });
  const controller = new BrowserInteractionController({
    browserSessionId,
    controllerGeneration,
    driver,
  });
  let cdp: CdpConnection | null = null;
  try {
    const tabId = (await driver.start(`${pages.url.origin}/page`)).target.id;
    const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
    const connection = await CdpConnection.connect(endpoint.cdpUrl);
    cdp = connection;
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: tabId,
      flatten: true,
    });
    await connection.send("Page.enable", {}, { sessionId });
    const evaluate = async (expression: string) =>
      (
        await connection.send<{ result: { value: unknown } }>(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          { sessionId },
        )
      ).result.value;
    const run = async (action: BrowserAction) => {
      const current = await driver.targetState(tabId);
      const command: BrowserActionCommand = {
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId,
        controllerGeneration,
        targetId: tabId,
        expectedTargetGeneration: current.targetGeneration,
        expectedDocumentGeneration: current.documentGeneration!,
        expectedFrameId: current.frameId!,
        actor: { kind: "human", subjectId: "interrupted-click-guard-fixture" },
        observationMode: "none",
        action,
      };
      return await controller.run(command);
    };
    const personClick = async (id: string) => {
      const { x, y } = (await evaluate(
        `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      )) as { x: number; y: number };
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
        await connection.send(
          "Input.dispatchMouseEvent",
          {
            type,
            x,
            y,
            ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }),
          },
          { sessionId },
        );
      }
    };
    const personAcceptDialog = async () => {
      await connection.send("Page.handleJavaScriptDialog", { accept: true }, { sessionId });
    };
    await use({ run, evaluate, personClick, personAcceptDialog });
  } finally {
    (cdp as CdpConnection | null)?.close();
    await driver.close();
    pages.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

e2e(
  "a person's clicks go through once the agent has answered a dialog that interrupted its click",
  async () => {
    await withFixture({ page: ALERT_ON_HOVER }, async (fixture) => {
      const interrupted = await fixture.run({
        type: "click",
        locator: { kind: "css", selector: "#go" },
      });
      expect(interrupted.observation?.dialog?.message ?? interrupted.error?.message).toContain(
        "Hovered",
      );
      const answered = await fixture.run({ type: "handle_dialog", response: "accept" });
      expect(answered.state).toBe("completed");
      // The person clicks elsewhere on the page, twice, shortly afterwards.
      await Bun.sleep(1_000);
      await fixture.personClick("other");
      await Bun.sleep(1_000);
      await fixture.personClick("other");
      expect(await fixture.evaluate("[clicks.go, clicks.other]")).toEqual([0, 2]);
    });
  },
  60_000,
);

e2e(
  "a guard a dialog interrupted before its press disarms soon after the dialog closes",
  async () => {
    // The driver never hears that the dialog closed, so it cannot remove the
    // guard itself: the guard must disarm on its own, a few seconds after the
    // page handled the pointer's move.
    await withFixture({ page: ALERT_ON_HOVER, driverMissesDialogClose: true }, async (fixture) => {
      const interrupted = await fixture.run({
        type: "click",
        locator: { kind: "css", selector: "#go" },
      });
      expect(interrupted.observation?.dialog?.message ?? interrupted.error?.message).toContain(
        "Hovered",
      );
      await fixture.personAcceptDialog();
      await Bun.sleep(6_500);
      await fixture.personClick("other");
      expect(await fixture.evaluate("[clicks.go, clicks.other]")).toEqual([0, 1]);
    });
  },
  60_000,
);

e2e(
  "a click on a page that stops presses before the guard sees them is done once it lands on the target",
  async () => {
    await withFixture({ page: stopsPresses() }, async (fixture) => {
      const result = await fixture.run({
        type: "click",
        locator: { kind: "css", selector: "#go" },
      });
      expect(result.error ?? null).toBeNull();
      expect(result.state).toBe("completed");
      expect(await fixture.evaluate("[clicks.go, clicks.card]")).toEqual([1, 0]);

      const twice = await fixture.run({
        type: "double_click",
        locator: { kind: "css", selector: "#go" },
      });
      expect(twice.error ?? null).toBeNull();
      expect(twice.state).toBe("completed");
      expect(await fixture.evaluate("[clicks.go, clicks.card]")).toEqual([3, 0]);
    });
  },
  60_000,
);

e2e(
  "a click on a page that stops presses is not counted as done when it lands on something else",
  async () => {
    // The pointer's arrival opens a card over "Go"; the guard never sees the
    // press and cannot hold it back, and the click lands on the card.
    await withFixture(
      {
        page: stopsPresses(
          '<script>go.addEventListener("mouseenter",()=>{card.style.display="block"});</script>',
        ),
      },
      async (fixture) => {
        const result = await fixture.run({
          type: "click",
          locator: { kind: "css", selector: "#go" },
        });
        expect(result.state).not.toBe("completed");
        expect(await fixture.evaluate("clicks.go")).toBe(0);
      },
    );
  },
  60_000,
);
