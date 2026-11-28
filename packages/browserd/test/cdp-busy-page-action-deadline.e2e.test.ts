import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  browserActionDeadlineMs,
  INTERACTION_REQUEST_TIMEOUT_MS,
  type BrowserActionCommand,
  type BrowserObservation,
} from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

/** Keeps the page's main thread busy in stretches of `ms` with a short gap
 * between them: the page still answers, but every read waits that long. */
const busyLoop = (ms: number) =>
  `setInterval(() => { const end = Date.now() + ${ms}; while (Date.now() < end) {} }, 30)`;

/**
 * The caller stops waiting for an action at the deadline derived from its
 * declared waits. A click on a page that keeps its main thread busy used to
 * run its few dozen page reads past that deadline (over two minutes here),
 * so the caller gave up without knowing whether the click happened. The
 * action now answers within the deadline and says whether input was sent.
 */
async function withBusyPage(
  busyFrom: "load" | "click",
  run: (fixture: {
    driver: AgentBrowserDriver;
    controller: BrowserInteractionController;
    initial: BrowserObservation;
    click: (
      observation: BrowserObservation,
      name: string,
      observationMode: "full" | "none",
    ) => BrowserActionCommand;
    clicked: () => string[];
  }) => Promise<void>,
  busyMs = 3_000,
): Promise<void> {
  const clicks: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/clicked") {
        clicks.push(url.searchParams.get("button") ?? "");
        return new Response(null, { status: 204 });
      }
      const busyNow = busyFrom === "load";
      return new Response(
        `<!doctype html><title>Conversations</title>
        <button onclick="fetch('/clicked?button=open')${busyNow ? "" : `; ${busyLoop(6_000)}`}">Open conversation</button>
        ${busyNow ? `<script>setTimeout(() => ${busyLoop(busyMs)}, 1000)</script>` : ""}`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const directory = await mkdtemp("/tmp/ogb-busy-page-");
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
  try {
    await run({
      driver,
      controller,
      initial: await driver.start(`http://127.0.0.1:${server.port}/`),
      click: (observation, name, observationMode) => ({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId,
        controllerGeneration,
        targetId: observation.target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId!,
        actor: { kind: "human", subjectId: "busy-page-fixture" },
        observationMode,
        action: { type: "click", locator: { kind: "role", role: "button", name, exact: false } },
      }),
      clicked: () => clicks,
    });
  } finally {
    await driver.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

const clickDeadlineMs = browserActionDeadlineMs({
  type: "click",
  locator: { kind: "role", role: "button", name: "Open conversation" },
});

e2e(
  "a click on a page too busy to prepare it answers in time and sends nothing",
  async () => {
    await withBusyPage("load", async ({ controller, initial, click, clicked }) => {
      // The page starts its busy loop a second after it loaded.
      await Bun.sleep(1_500);
      const started = Date.now();
      const result = await controller.run(click(initial, "Open conversation", "none"));
      expect(Date.now() - started).toBeLessThan(clickDeadlineMs - 3_000);
      expect(result.state).toBe("failed");
      expect(result.error?.code).toBe("tab_not_responding");
      expect(result.error?.message).toContain("nothing was sent");
      await Bun.sleep(500);
      expect(clicked()).toEqual([]);
    });
  },
  180_000,
);

e2e(
  "a click whose page then stays busy answers in time and says the input was sent",
  async () => {
    await withBusyPage("click", async ({ controller, initial, click, clicked }) => {
      const started = Date.now();
      const result = await controller.run(click(initial, "Open conversation", "full"));
      expect(Date.now() - started).toBeLessThan(clickDeadlineMs - 3_000);
      expect(result.state).toBe("outcome_unknown");
      expect(result.error?.code).toBe("tab_not_responding");
      expect(result.error?.message).toContain("The input was sent");
      expect(clicked()).toEqual(["open"]);
    });
  },
  180_000,
);

/**
 * A page read has no declared waits, and the API stops waiting for it after
 * INTERACTION_REQUEST_TIMEOUT_MS. On a page whose main thread is busy for
 * seconds at a time (software-rendered WebGL does this), an observation's page
 * commands each answered within their own timeout but together ran past the
 * API's, which then reported a lost transport. The read now says in time that
 * the tab did not answer.
 */
e2e(
  "an observation of a page too busy to read answers before the API stops waiting",
  async () => {
    await withBusyPage(
      "load",
      async ({ driver, initial }) => {
        await Bun.sleep(1_500);
        const started = Date.now();
        const failure = await driver.observe(initial.target.id).then(
          () => null,
          (error: unknown) => error,
        );
        expect(Date.now() - started).toBeLessThan(INTERACTION_REQUEST_TIMEOUT_MS - 5_000);
        expect(failure).toMatchObject({ code: "tab_not_responding", retryable: false });
      },
      8_000,
    );
  },
  240_000,
);
