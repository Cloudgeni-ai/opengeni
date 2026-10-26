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

e2e(
  "network idle tracks cross-site frames and ignores what the page does not wait for",
  async () => {
    const encoder = new TextEncoder();
    const held = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const later = (ms: number, body: string) =>
      new Promise<Response>((resolve) =>
        setTimeout(
          () => resolve(new Response(body, { headers: { "content-type": "text/plain" } })),
          ms,
        ),
      );
    // Pages load from 127.0.0.1 and frame localhost, another site, so each
    // frame runs in its own process with its own CDP session.
    const server = Bun.serve({
      port: 0,
      // The long poll and the stalled body stay open well past Bun's default.
      idleTimeout: 60,
      fetch(request) {
        const url = new URL(request.url);
        const other = `http://localhost:${url.port}`;
        if (url.pathname === "/slow") return later(3_000, "loaded");
        if (url.pathname === "/beacon") return new Response(null, { status: 204 });
        if (url.pathname === "/slow-worker.js" || url.pathname === "/quick-worker.js")
          return new Response(
            url.pathname === "/slow-worker.js"
              ? 'fetch("/slow").then((r)=>r.text()).then((t)=>postMessage("worker "+t))'
              : 'postMessage("worker ran")',
            { headers: { "content-type": "text/javascript" } },
          );
        if (url.pathname === "/poll") return new Promise<Response>(() => {});
        if (url.pathname === "/trickle") {
          // A streamed answer: a chunk every 800 ms, done after about 5 s.
          let sent = 0;
          let timer: ReturnType<typeof setInterval> | undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                timer = setInterval(() => {
                  controller.enqueue(encoder.encode(`chunk ${sent} `));
                  sent += 1;
                  if (sent === 6) {
                    clearInterval(timer);
                    controller.close();
                  }
                }, 800);
              },
              cancel() {
                clearInterval(timer);
              },
            }),
            { headers: { "content-type": "text/plain" } },
          );
        }
        if (url.pathname === "/stall") {
          // Headers and a first chunk, then nothing more, ever.
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                held.add(controller);
                controller.enqueue(encoder.encode("first"));
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        const pages: Record<string, string> = {
          "/framed": '<script>document.querySelector("output").textContent="framed"</script>',
          "/framed-slow":
            '<script>fetch("/slow").then((r)=>r.text()).then((t)=>{document.querySelector("output").textContent="frame "+t})</script>',
          "/frame-idle": `<iframe src="${other}/framed"></iframe><script>document.querySelector("output").textContent="ready"</script>`,
          "/frame-slow": `<iframe src="${other}/framed-slow"></iframe>`,
          "/frame-on-click": `<button onclick="const f=document.createElement('iframe');f.src='${other}/framed';document.body.append(f)">Embed</button>`,
          "/beacons":
            '<script>document.querySelector("output").textContent="ready";setInterval(()=>navigator.sendBeacon("/beacon","x"),300)</script>',
          "/streamed":
            '<script>fetch("/trickle").then(async(r)=>{const reader=r.body.getReader();const d=new TextDecoder();let text="";for(;;){const {done,value}=await reader.read();if(done)break;text+=d.decode(value);document.querySelector("output").textContent=text}})</script>',
          "/stalled":
            '<script>document.querySelector("output").textContent="ready";fetch("/stall").then((r)=>r.body.getReader().read())</script>',
          "/worker-at-load":
            '<script>new Worker("/slow-worker.js").onmessage=(e)=>{document.querySelector("output").textContent=e.data}</script>',
          "/worker-later":
            '<script>document.querySelector("output").textContent="ready";setTimeout(()=>{new Worker("/quick-worker.js").onmessage=(e)=>{document.querySelector("output").textContent=e.data}},2000)</script>',
          "/framed-worker":
            '<script>new Worker("/quick-worker.js").onmessage=(e)=>{document.querySelector("output").textContent="frame "+e.data}</script>',
          "/frame-worker": `<iframe src="${other}/framed-worker"></iframe>`,
          "/long-poll":
            '<script>document.querySelector("output").textContent="ready";fetch("/poll")</script>',
        };
        const page = pages[url.pathname] ?? "";
        return new Response(`<!doctype html><title>Live page</title><output>-</output>${page}`, {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const directory = await mkdtemp("/tmp/ogb-network-idle-frames-");
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
      const initial = await driver.start("about:blank");
      const run = async (action: BrowserActionCommand["action"]) => {
        const receipt = await controller.run(
          command(await driver.observe(initial.target.id), action),
        );
        expect(receipt.error ?? null).toBeNull();
        expect(receipt.state).toBe("completed");
        return receipt;
      };
      const idleAfter = async (path: string, timeoutMs = 30_000) => {
        await run({ type: "navigate", url: `${origin}${path}` });
        const started = Date.now();
        const receipt = await run({ type: "wait", condition: "network_idle", timeoutMs });
        return { ms: Date.now() - started, receipt };
      };
      const output = async () => JSON.stringify((await driver.observe(initial.target.id)).semantic);

      // A cross-site frame's document request ends on the frame's own session.
      // The page is idle once the frame has loaded, not after the whole wait.
      const frame = await idleAfter("/frame-idle");
      expect(frame.ms).toBeLessThan(8_000);
      expect(frame.receipt.notes ?? []).toEqual([]);

      // The frame's own requests count: its content is loading for 3 s.
      const slowFrame = await idleAfter("/frame-slow");
      expect(slowFrame.ms).toBeGreaterThanOrEqual(2_000);
      expect(slowFrame.receipt.notes ?? []).toEqual([]);
      expect(await output()).toContain("frame loaded");

      // A click that embeds a cross-site frame leaves nothing loading for good.
      await run({ type: "navigate", url: `${origin}/frame-on-click` });
      await run({ type: "click", locator: { kind: "role", role: "button", name: "Embed" } });
      const started = Date.now();
      await run({ type: "wait", condition: "network_idle", timeoutMs: 30_000 });
      expect(Date.now() - started).toBeLessThan(8_000);

      // Beacons are not the page loading.
      expect((await idleAfter("/beacons")).ms).toBeLessThan(8_000);

      // A streamed answer that keeps sending is still loading until it ends.
      const streamed = await idleAfter("/streamed");
      expect(streamed.ms).toBeGreaterThanOrEqual(3_000);
      expect(await output()).toContain("chunk 5");

      // A body that stopped sending data is not loading once it has been
      // silent for the stall window.
      const stalled = await idleAfter("/stalled");
      expect(stalled.ms).toBeGreaterThanOrEqual(2_000);
      expect(stalled.ms).toBeLessThan(9_000);
      expect(stalled.receipt.notes?.[0]?.kind).toBe("network_busy");
      expect(stalled.receipt.notes?.[0]?.message).toBe(
        "page loaded; its network went quiet except for 1 response whose body has had no data for 3 s (as paused streams do; more may still arrive), so the wait ended without it",
      );

      // Dedicated workers run, and their requests are the page loading: the
      // worker's script ends on its own session, and its 3 s fetch counts.
      const worker = await idleAfter("/worker-at-load");
      expect(worker.ms).toBeGreaterThanOrEqual(2_000);
      expect(worker.ms).toBeLessThan(8_000);
      expect(worker.receipt.notes ?? []).toEqual([]);
      expect(await output()).toContain("worker loaded");
      // A worker started later, and one in a cross-site frame, run too.
      await run({ type: "navigate", url: `${origin}/worker-later` });
      await Bun.sleep(4_000);
      expect(await output()).toContain("worker ran");
      const frameWorker = await idleAfter("/frame-worker");
      expect(frameWorker.ms).toBeLessThan(8_000);
      expect(frameWorker.receipt.notes ?? []).toEqual([]);
      await Bun.sleep(500);
      expect(await output()).toContain("frame worker ran");

      // A request with no response for 10 s is taken for a long poll: the wait
      // ends after it and says so.
      const poll = await idleAfter("/long-poll", 20_000);
      expect(poll.ms).toBeGreaterThanOrEqual(9_000);
      expect(poll.ms).toBeLessThan(18_000);
      expect(poll.receipt.notes?.[0]?.kind).toBe("network_busy");
      expect(poll.receipt.notes?.[0]?.message).toBe(
        "page loaded; its network went quiet except for 1 request still waiting for a response after 10 s (as long polls do), so the wait ended without it",
      );
    } finally {
      await driver.close();
      for (const open of held) {
        try {
          open.close();
        } catch {}
      }
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
