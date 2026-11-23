import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e =
  process.env.OPENGENI_BROWSERD_E2E === "1" || process.env.OPENGENI_BROWSERD_HEADED_E2E === "1"
    ? test
    : test.skip;

e2e(
  "frame stream health says when and why a stream stopped producing frames",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-frame-health-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: process.env.OPENGENI_BROWSERD_HEADED_E2E === "1",
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
      focusEmulation: true,
    });
    let cdp: CdpConnection | null = null;
    let frames: import("../src").BrowserFrameSubscription | null = null;
    try {
      const initial = await driver.start(
        `data:text/html,${encodeURIComponent("<!doctype html><title>Health</title><h1>Health</h1>")}`,
      );
      expect(driver.frameStreamHealth().streams).toEqual([]);
      frames = await driver.subscribeFrames(initial.target.id, { format: "jpeg" });
      const iterator = frames[Symbol.asyncIterator]();
      const drain = (async () => {
        for (;;) if ((await iterator.next()).done) return;
      })();
      await Bun.sleep(1_000);
      const healthy = driver.frameStreamHealth().streams;
      expect(healthy).toHaveLength(1);
      expect(healthy[0]).toMatchObject({
        targetId: initial.target.id,
        subscribers: 1,
        seeded: true,
        pollerRunning: true,
        pollerEnded: null,
        unresponsiveForMs: null,
        consecutiveFailures: 0,
      });
      expect(healthy[0]!.sinceLastFrameMs).toBeLessThan(1_000);

      // The page's main thread stops answering, so no frame can be captured.
      const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      cdp = await CdpConnection.connect(endpoint.cdpUrl);
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: initial.target.id,
        flatten: true,
      });
      void cdp
        .send(
          "Runtime.evaluate",
          { expression: "for (const end = Date.now() + 8000; Date.now() < end;);" },
          { sessionId: attached.sessionId, timeoutMs: 20_000 },
        )
        .catch(() => undefined);
      await Bun.sleep(5_000);
      const stalled = driver.frameStreamHealth().streams[0]!;
      expect(stalled.subscribers).toBe(1);
      expect(stalled.pollerRunning).toBe(true);
      expect(stalled.sinceLastFrameMs).toBeGreaterThan(3_000);
      expect(stalled.unresponsiveForMs).toBeGreaterThan(1_000);
      expect(stalled.unresponsiveMethod).toMatch(/^Page\./);

      // The page answers again and the stream recovers.
      await Bun.sleep(6_000);
      const recovered = driver.frameStreamHealth().streams[0]!;
      expect(recovered.sinceLastFrameMs).toBeLessThan(1_000);
      expect(recovered.unresponsiveForMs).toBeNull();
      await frames.close();
      frames = null;
      await drain;
      expect(driver.frameStreamHealth().streams).toEqual([]);
    } finally {
      await frames?.close();
      cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
