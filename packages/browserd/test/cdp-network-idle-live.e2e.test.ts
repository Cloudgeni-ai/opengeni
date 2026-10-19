import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  resolvePinnedAgentBrowserBinary,
} from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "network idle settles on live pages that keep an event stream or long poll open",
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
        if (url.pathname === "/poll") {
          // A long poll the server never answers.
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                openStreams.add(controller);
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        const page =
          url.pathname === "/stream"
            ? '<script>new EventSource("/events").onmessage=(e)=>{document.querySelector("output").textContent=e.data}</script>'
            : '<script>fetch("/poll").catch(()=>{})</script>';
        return new Response(`<!doctype html><title>Live page</title><output>-</output>${page}`, {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const directory = await mkdtemp("/tmp/ogb-network-idle-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `idle_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
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
      // An open event stream is never page loading, so idle comes quickly.
      const stream = await driver.start(`${origin}/stream`);
      let started = Date.now();
      const streamIdle = await controller.run(
        command(stream, { type: "wait", condition: "network_idle", timeoutMs: 8_000 }),
      );
      expect(streamIdle.error ?? null).toBeNull();
      expect(streamIdle.state).toBe("completed");
      expect(Date.now() - started).toBeLessThan(5_000);

      // A request left open stops counting once it has outlived page loading.
      const navigated = await controller.run(
        command(stream, { type: "navigate", url: `${origin}/poll-page` }),
      );
      expect(navigated.state).toBe("completed");
      const poll = await driver.observe(stream.target.id);
      started = Date.now();
      const pollIdle = await controller.run(
        command(poll, { type: "wait", condition: "network_idle", timeoutMs: 20_000 }),
      );
      expect(pollIdle.error ?? null).toBeNull();
      expect(pollIdle.state).toBe("completed");
      expect(Date.now() - started).toBeLessThan(15_000);
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
