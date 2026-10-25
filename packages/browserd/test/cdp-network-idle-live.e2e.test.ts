import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "network idle ignores event streams but waits for every request that can finish",
  async () => {
    const encoder = new TextEncoder();
    const openStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/events") {
          // An event stream that keeps sending and never ends.
          let timer: ReturnType<typeof setInterval> | undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                openStreams.add(controller);
                controller.enqueue(encoder.encode("data: hello\n\n"));
                timer = setInterval(() => {
                  try {
                    controller.enqueue(encoder.encode("data: tick\n\n"));
                  } catch {
                    clearInterval(timer);
                  }
                }, 200);
              },
              cancel() {
                clearInterval(timer);
              },
            }),
            { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
          );
        }
        if (url.pathname === "/slow") {
          // A finite response that takes a while: the page is still loading.
          return new Promise<Response>((resolve) =>
            setTimeout(
              () =>
                resolve(
                  new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
                ),
              3_000,
            ),
          );
        }
        if (url.pathname === "/poll") {
          // A long poll the server never answers while the page is open.
          return new Promise<Response>(() => {});
        }
        const pages: Record<string, string> = {
          "/event-source":
            '<script>new EventSource("/events").onmessage=(e)=>{document.querySelector("output").textContent=e.data}</script>',
          // Apps that stream through fetch read the same event stream body.
          "/fetch-stream":
            '<script>fetch("/events").then(async(r)=>{const reader=r.body.getReader();for(;;){const {done}=await reader.read();if(done)break;document.querySelector("output").textContent="tick"}})</script>',
          "/slow-page":
            '<script>fetch("/slow").then((r)=>r.json()).then(()=>{document.querySelector("output").textContent="loaded"})</script>',
          "/long-poll":
            '<script>document.querySelector("output").textContent="ready";fetch("/poll")</script>',
        };
        const page = pages[url.pathname] ?? "";
        return new Response(`<!doctype html><title>Live page</title><output>-</output>${page}`, {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const directory = await mkdtemp("/tmp/ogb-network-idle-");
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
      actor: { kind: "human", subjectId: "network-idle-fixture" },
      observationMode: "none",
      action,
    });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const initial = await driver.start(`${origin}/event-source`);
      const idleAt = async (path: string, timeoutMs: number) => {
        if (path !== "/event-source") {
          const navigated = await controller.run(
            command(await driver.observe(initial.target.id), {
              type: "navigate",
              url: `${origin}${path}`,
            }),
          );
          expect(navigated.state).toBe("completed");
        }
        const started = Date.now();
        const idle = await controller.run(
          command(await driver.observe(initial.target.id), {
            type: "wait",
            condition: "network_idle",
            timeoutMs,
          }),
        );
        expect(idle.error ?? null).toBeNull();
        expect(idle.state).toBe("completed");
        return Date.now() - started;
      };
      const output = async () => {
        const view = await driver.observe(initial.target.id);
        return JSON.stringify(view.semantic);
      };

      // An open event stream is never page loading, so idle comes quickly,
      // whether the page reads it as an EventSource or through fetch.
      expect(await idleAt("/event-source", 8_000)).toBeLessThan(5_000);
      expect(await idleAt("/fetch-stream", 8_000)).toBeLessThan(5_000);
      expect(await output()).toContain("tick");

      // A slow finite request keeps the page busy until it finishes.
      await idleAt("/slow-page", 15_000);
      expect(await output()).toContain("loaded");

      // A loaded page whose long poll never ends never goes idle. The wait
      // runs its full time and then completes, and its receipt says the
      // network was still busy instead of reporting idle.
      const navigated = await controller.run(
        command(await driver.observe(initial.target.id), {
          type: "navigate",
          url: `${origin}/long-poll`,
        }),
      );
      expect(navigated.state).toBe("completed");
      const started = Date.now();
      const pollWait = await controller.run(
        command(await driver.observe(initial.target.id), {
          type: "wait",
          condition: "network_idle",
          timeoutMs: 2_000,
        }),
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
      expect(pollWait.error ?? null).toBeNull();
      expect(pollWait.state).toBe("completed");
      expect(pollWait.notes?.[0]?.kind).toBe("network_busy");
      expect(pollWait.notes?.[0]?.message).toContain("its network was still busy after 2 s");
      expect(await output()).toContain("ready");
    } finally {
      await driver.close();
      for (const open of openStreams) {
        try {
          open.close();
        } catch {}
      }
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
