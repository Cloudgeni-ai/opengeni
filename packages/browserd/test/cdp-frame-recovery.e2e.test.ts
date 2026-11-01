import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import sharp from "sharp";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import type { BrowserFrameSubscription } from "../src/media";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

function command(
  observation: BrowserObservation,
  action: BrowserActionCommand["action"],
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "browserd-frame-recovery-e2e" },
    observationMode: "none",
    action,
  };
}

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture deadline exceeded")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

e2e.each([4_000, 13_000])(
  "the same live stream recovers after a %i ms busy page, without blocking browser actions",
  async (busyMs) => {
    let requested = false;
    const entered = Promise.withResolvers<void>();
    const recovered = Promise.withResolvers<void>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/step") {
          const duration = requested ? busyMs : 0;
          requested = false;
          return Response.json(duration);
        }
        if (path === "/entered") entered.resolve();
        if (path === "/recovered") recovered.resolve();
        if (path !== "/") return new Response("ok");
        return new Response(
          `<!doctype html><title>Frame recovery</title>
          <style>body { margin: 0; background: #cc0000; } input, button { margin: 20px; }</style>
          <input aria-label="Message"><button onclick="document.body.style.background='#0000cc'">Apply</button>
          <script>
          async function poll() {
            const duration = await (await fetch('/step')).json();
            if (duration) {
              await fetch('/entered');
              const until = performance.now() + duration;
              while (performance.now() < until) {}
              document.body.style.background = '#00cc00';
              await fetch('/recovered');
            }
            setTimeout(poll, 50);
          }
          poll();
          </script>`,
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    const directory = await mkdtemp("/tmp/ogb-frame-recovery-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: process.env.OPENGENI_BROWSERD_HEADED_E2E === "1",
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
    });
    let frames: BrowserFrameSubscription | undefined;
    try {
      const initial = await driver.start(server.url.href);
      const other = await driver.openTarget(
        "data:text/html,<title>Other tab</title><input aria-label='Other'>",
      );
      frames = await driver.subscribeFrames(initial.target.id, { format: "jpeg" });
      const iterator = frames[Symbol.asyncIterator]();
      const nextColor = async (channel: number) => {
        for (;;) {
          const frame = await iterator.next();
          expect(frame.done).toBe(false);
          if (frame.done) throw new Error("live stream ended");
          const pixel = await sharp(frame.value.data)
            .extract({ left: 0, top: 0, width: 1, height: 1 })
            .removeAlpha()
            .raw()
            .toBuffer();
          if (pixel[channel]! > 150 && pixel[(channel + 1) % 3]! < 50) return;
        }
      };
      await bounded(nextColor(0), 5_000);
      requested = true;
      await bounded(entered.promise, 5_000);
      // Frames on a busy tab must not occupy another tab's command queue.
      await bounded(
        (async () =>
          await driver.dispatch(
            command(await driver.observe(other.target.id), {
              type: "type",
              locator: { kind: "label", text: "Other" },
              text: "unblocked",
            }),
          ))(),
        5_000,
      );
      await bounded(recovered.promise, busyMs + 5_000);
      // No resubscription: both a real changed image and later input must arrive.
      await bounded(nextColor(1), 5_000);
      await driver.dispatch(
        command(await driver.observe(initial.target.id), {
          type: "type",
          locator: { kind: "label", text: "Message" },
          text: "after recovery",
        }),
      );
      await driver.dispatch(
        command(await driver.observe(initial.target.id), {
          type: "click",
          locator: { kind: "role", role: "button", name: "Apply" },
        }),
      );
      await bounded(nextColor(2), 5_000);
      const observation = await driver.observe(initial.target.id);
      expect(JSON.stringify(observation)).toContain("after recovery");
    } finally {
      await frames?.close();
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  45_000,
);

e2e(
  "a live stream opened while its page is already busy shows the page once it answers",
  async () => {
    const busyMs = 12_000;
    let requested = false;
    const entered = Promise.withResolvers<void>();
    const recovered = Promise.withResolvers<void>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/step") {
          const duration = requested ? busyMs : 0;
          requested = false;
          return Response.json(duration);
        }
        if (path === "/entered") entered.resolve();
        if (path === "/recovered") recovered.resolve();
        if (path !== "/") return new Response("ok");
        return new Response(
          `<!doctype html><title>Busy on open</title>
          <style>body { margin: 0; background: #cc0000; }</style>
          <script>
          async function poll() {
            const duration = await (await fetch('/step')).json();
            if (duration) {
              await fetch('/entered');
              const until = performance.now() + duration;
              while (performance.now() < until) {}
              document.body.style.background = '#00cc00';
              await fetch('/recovered');
            }
            setTimeout(poll, 50);
          }
          poll();
          </script>`,
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    const directory = await mkdtemp("/tmp/ogb-frame-recovery-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: process.env.OPENGENI_BROWSERD_HEADED_E2E === "1",
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
    });
    let frames: BrowserFrameSubscription | undefined;
    try {
      const initial = await driver.start(server.url.href);
      // Busy only once the page has loaded and the browser is started.
      requested = true;
      await bounded(entered.promise, 5_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Opening the view during the busy period used to fail after about 6 s.
      frames = await bounded(driver.subscribeFrames(initial.target.id, { format: "jpeg" }), busyMs);
      const iterator = frames[Symbol.asyncIterator]();
      await bounded(recovered.promise, busyMs + 5_000);
      await bounded(
        (async () => {
          for (;;) {
            const frame = await iterator.next();
            if (frame.done) throw new Error("live stream ended");
            const pixel = await sharp(frame.value.data)
              .extract({ left: 0, top: 0, width: 1, height: 1 })
              .removeAlpha()
              .raw()
              .toBuffer();
            if (pixel[1]! > 150 && pixel[0]! < 50) return;
          }
        })(),
        5_000,
      );
    } finally {
      await frames?.close();
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  45_000,
);
