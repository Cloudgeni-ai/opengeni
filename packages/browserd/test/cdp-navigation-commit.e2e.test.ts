import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, BrowserSupervisor, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

// Every page here polls its server and keeps one request open forever, as
// live consoles and dashboards do, so its network never goes idle.
const livePage = (name: string) => `<!doctype html><title>Page ${name}</title>
<h1>Page ${name}</h1>
<button onclick="fetch('/mutate?page=${name}',{method:'POST'})">Grant access</button>
<script>
setInterval(()=>fetch('/tick').catch(()=>{}),150);
fetch('/hang').catch(()=>{});
</script>`;

const spaPage = `<!doctype html><title>Wizard</title>
<h1>Step 1</h1>
<button onclick="history.pushState({},'','/spa/2');render()">Next</button>
<script>
function render(){document.querySelector('h1').textContent='Step '+location.pathname.split('/').pop()}
addEventListener('popstate',render);
render();
setInterval(()=>fetch('/tick').catch(()=>{}),150);
</script>`;

e2e(
  "navigation completes only once its page committed, and never-idle pages say so",
  async () => {
    const mutations: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/mutate") {
          mutations.push(url.searchParams.get("page") ?? "?");
          return new Response("ok");
        }
        if (url.pathname === "/tick") return new Response("tick");
        if (url.pathname === "/hang") return await new Promise<Response>(() => {});
        // An HTTP error status with no body: the browser shows its own page
        // naming the status.
        if (url.pathname === "/status/500") return new Response(null, { status: 500 });
        if (url.pathname.startsWith("/spa/"))
          return new Response(spaPage, { headers: { "content-type": "text/html" } });
        if (url.pathname.startsWith("/slow/")) await Bun.sleep(1_500);
        const name = url.pathname.split("/").pop() || "a";
        return new Response(livePage(name), { headers: { "content-type": "text/html" } });
      },
    });
    const directory = await mkdtemp("/tmp/ogb-navigation-commit-");
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
    const origin = `http://127.0.0.1:${server.port}`;
    const run = async (action: BrowserActionCommand["action"]) => {
      const observation: BrowserObservation = await driver.observe(targetId);
      return await controller.run({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId,
        controllerGeneration,
        targetId,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId!,
        actor: { kind: "human", subjectId: "navigation-commit-fixture" },
        action,
      });
    };
    const heading = async () =>
      (await driver.observe(targetId)).semantic?.kind === "snapshot"
        ? JSON.stringify((await driver.observe(targetId)).semantic).match(/Step \d|Page \w+/)?.[0]
        : undefined;
    let targetId = "";
    try {
      targetId = (await driver.start(`${origin}/page/a`)).target.id;

      // network_idle on a page that never idles: the navigation committed, so
      // the receipt is definite and shows the new page, and the wait says
      // that the network did not go idle instead of reporting success.
      const started = Date.now();
      const idle = await run({
        type: "batch",
        actions: [
          { type: "navigate", url: `${origin}/page/b` },
          { type: "wait", condition: "network_idle", timeoutMs: 2_000 },
        ],
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
      expect(idle.state).toBe("failed");
      expect(idle.error?.code).toBe("timeout");
      expect(idle.error?.message).toContain("after the preceding navigation committed");
      expect(idle.error?.message).toContain("network did not go idle within 2 s");
      expect(idle.observation?.target.url).toBe(`${origin}/page/b`);
      expect(await heading()).toBe("Page b");

      // waitUntil 'load' on the same kind of page completes on the new page.
      const loaded = await run({
        type: "batch",
        actions: [
          { type: "navigate", url: `${origin}/page/c` },
          { type: "wait", condition: "load" },
        ],
      });
      expect(loaded.error ?? null).toBeNull();
      expect(loaded.state).toBe("completed");
      expect(loaded.observation?.target.url).toBe(`${origin}/page/c`);

      // An action after a slow navigation resolves its element in the page
      // the navigation committed, never in the page it left.
      const clicked = await run({
        type: "batch",
        actions: [
          { type: "navigate", url: `${origin}/slow/d` },
          { type: "click", locator: { kind: "role", role: "button", name: "Grant access" } },
        ],
      });
      expect(clicked.error ?? null).toBeNull();
      expect(clicked.state).toBe("completed");
      for (let index = 0; index < 40 && mutations.length === 0; index += 1) await Bun.sleep(50);
      await Bun.sleep(300);
      expect(mutations).toEqual(["d"]);

      // Soft navigations: pushState entries and fragments commit within the
      // document, and history steps wait for the entry they asked for.
      expect((await run({ type: "navigate", url: `${origin}/spa/1` })).state).toBe("completed");
      const next = await run({
        type: "click",
        locator: { kind: "role", role: "button", name: "Next" },
      });
      expect(next.state).toBe("completed");
      expect(next.observation?.target.url).toBe(`${origin}/spa/2`);
      expect(await heading()).toBe("Step 2");
      const back = await run({ type: "history", direction: "back" });
      expect(back.error ?? null).toBeNull();
      expect(back.observation?.target.url).toBe(`${origin}/spa/1`);
      expect(await heading()).toBe("Step 1");
      const forward = await run({ type: "history", direction: "forward" });
      expect(forward.error ?? null).toBeNull();
      expect(forward.observation?.target.url).toBe(`${origin}/spa/2`);
      expect(await heading()).toBe("Step 2");
      const fragment = await run({ type: "navigate", url: `${origin}/spa/2#details` });
      expect(fragment.error ?? null).toBeNull();
      expect(fragment.state).toBe("completed");
      expect(await heading()).toBe("Step 2");

      // Back across documents, from the single-page app to a live page.
      const across = await run({
        type: "batch",
        actions: [
          { type: "history", direction: "back" },
          { type: "history", direction: "back" },
          { type: "history", direction: "back" },
        ],
      });
      expect(across.error ?? null).toBeNull();
      expect(across.observation?.target.url).toBe(`${origin}/slow/d`);
      expect(await heading()).toBe("Page d");

      // A server that answered with an HTTP error status gave the page its
      // answer: navigate completes on the page naming that status.
      const status = await run({ type: "navigate", url: `${origin}/status/500` });
      expect(status.error ?? null).toBeNull();
      expect(status.state).toBe("completed");
      // The tab shows the browser's own page, whose text names the status.
      expect(status.observation?.target.url).toStartWith("chrome-error:");
      expect(JSON.stringify(status.observation?.semantic)).toContain("HTTP ERROR 500");

      // A page no server answered fails, and its failure shows the error page
      // the tab committed for it, not the page it left.
      const freed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const refused = `http://127.0.0.1:${freed.port}/refused`;
      freed.stop(true);
      const failed = await run({ type: "navigate", url: refused });
      // The request went out, so the outcome stays conservative.
      expect(failed.state).toBe("outcome_unknown");
      expect(failed.error?.message).toContain("net::ERR_CONNECTION_REFUSED");
      expect(failed.observation?.target.url).toStartWith("chrome-error:");
      expect(JSON.stringify(failed.observation?.semantic)).toContain("ERR_CONNECTION_REFUSED");
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);

e2e(
  "a browser opens on its first page even when that page fails to load",
  async () => {
    const root = await mkdtemp("/tmp/ogb-open-error-");
    const supervisor = await BrowserSupervisor.open({ rootDirectory: root, maxSessions: 2 });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(null, { status: 503 }),
    });
    const freed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const refused = `http://127.0.0.1:${freed.port}/`;
    freed.stop(true);
    const open = (initialUrl: string) => ({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      headed: false,
      transport: { kind: "managed" as const, engine: "chromium" as const },
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
      initialUrl,
    });
    try {
      // The session and its tab exist, and the tab shows what went wrong.
      const status = await supervisor.createSession(open(`http://127.0.0.1:${server.port}/`));
      expect(status.observation.target.url).toStartWith("chrome-error:");
      expect(JSON.stringify(status.observation.semantic)).toContain("HTTP ERROR 503");
      const unreachable = await supervisor.createSession(open(refused));
      expect(unreachable.observation.target.url).toStartWith("chrome-error:");
      expect(JSON.stringify(unreachable.observation.semantic)).toContain("ERR_CONNECTION_REFUSED");
    } finally {
      await supervisor.close();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
