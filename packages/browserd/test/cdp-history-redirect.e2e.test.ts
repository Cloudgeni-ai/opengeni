import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const page = (body: string) =>
  new Response(`<!doctype html>${body}`, {
    headers: { "content-type": "text/html", "cache-control": "no-store" },
  });

// A redirect step that sends the tab on whenever it is shown, as a sign-in
// flow's intermediate pages do when Back returns to them.
const redirectStep = (to: string) =>
  page(
    `<title>Redirecting</title><script>addEventListener('pageshow',()=>setTimeout(()=>{location.href=${JSON.stringify(to)}},0))</script>`,
  );

type Fixture = {
  origin: string;
  provider: () => string;
  /** The URL the tab shows now. */
  url: () => Promise<string>;
  run: (action: BrowserActionCommand["action"]) => ReturnType<BrowserInteractionController["run"]>;
  heading: () => Promise<string | undefined>;
  startFlow: (name: string, role?: "link" | "button") => Promise<void>;
};

const back = { type: "history", direction: "back" } as const;

async function withFixture(scenario: (fixture: Fixture) => Promise<void>): Promise<void> {
  let port = 0;
  // A second origin, as a sign-in provider is.
  const provider = () => `http://localhost:${port}`;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const signin = `${provider()}/signin${url.search}`;
      switch (url.pathname) {
        case "/login":
          return page(`<title>Login</title><h1>Login</h1>
<a href="/go/302">Continue 302</a>
<form method="post" action="/go/post"><button>Continue POST</button></form>
<a href="/go/href">Continue href</a>
<a href="/go/replace">Continue replace</a>
<a href="/go/step">Continue step</a>
<a href="/go/302?entries=same">Continue same entries</a>
<a href="/go/302?entries=paths">Continue path entries</a>
<a href="/go/chain/1">Continue chain</a>`);
        case "/go/302":
          return new Response(null, { status: 302, headers: { location: signin } });
        case "/go/post":
          return new Response(null, { status: 303, headers: { location: signin } });
        case "/go/href":
          return page(`<script>location.href=${JSON.stringify(signin)}</script>`);
        case "/go/replace":
          return page(`<script>location.replace(${JSON.stringify(signin)})</script>`);
        case "/go/step":
          return redirectStep(signin);
        case "/go/chain/1":
          return redirectStep("/go/chain/2");
        case "/go/chain/2":
          return redirectStep("/go/chain/3");
        case "/go/chain/3":
          return redirectStep(signin);
        // Ordinary pages a browser may keep in its back/forward cache.
        case "/plain/a":
          return new Response(
            `<!doctype html><title>Plain</title><h1>Plain</h1><script>addEventListener('pageshow',(event)=>{if(event.persisted)document.querySelector('h1').textContent='Restored'})</script>`,
            { headers: { "content-type": "text/html" } },
          );
        case "/plain/b":
          return new Response(`<!doctype html><title>Plain</title><h1>Plain</h1>`, {
            headers: { "content-type": "text/html" },
          });
        // A page that loads itself again when it is shown again.
        case "/plain/reload":
          return page(`<title>Plain</title><h1>Plain</h1><script>
if (sessionStorage.reloaded) document.querySelector('h1').textContent = 'Reloaded';
addEventListener('pageshow', () => {
  if (sessionStorage.seen && !sessionStorage.reloaded) { sessionStorage.reloaded = 1; location.reload(); }
  sessionStorage.seen = 1;
});
</script>`);
        case "/signin": {
          const entries = url.searchParams.get("entries");
          // Entries the page adds as it opens, without any input.
          const script =
            entries === "same"
              ? "history.pushState({s:1},'',location.href);history.pushState({s:2},'',location.href);"
              : entries === "paths"
                ? "history.pushState({s:1},'','/signin/identifier');"
                : "";
          // An entry the page adds after input, as a dialog that closes on
          // Back does.
          return page(`<title>Provider</title><h1>Sign in</h1>
<button onclick="history.pushState({dialog:1},'',location.href);document.querySelector('h1').textContent='Dialog'">Open dialog</button>
<script>addEventListener('popstate',()=>{document.querySelector('h1').textContent='Sign in'});${script}</script>`);
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  port = server.port!;
  const origin = `http://127.0.0.1:${port}`;
  const directory = await mkdtemp("/tmp/ogb-history-redirect-");
  const browserSessionId = randomUUID();
  const controllerGeneration = `controller-${randomUUID()}`;
  const runner = await ManagedBrowserRunner.create({
    profileDirectory: join(directory, "profile"),
    headed: process.env.OPENGENI_BROWSERD_HEADED_E2E === "1",
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
  let targetId = "";
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
      actor: { kind: "human", subjectId: "history-redirect-fixture" },
      action,
    });
  };
  const heading = async () =>
    JSON.stringify((await driver.observe(targetId)).semantic).match(
      /Sign in|Dialog|Login|Restored|Reloaded/,
    )?.[0];
  const startFlow = async (name: string, role: "link" | "button" = "link") => {
    expect((await run({ type: "navigate", url: `${origin}/login` })).state).toBe("completed");
    const clicked = await run({ type: "click", locator: { kind: "role", role, name } });
    expect(clicked.state).toBe("completed");
    // Let redirect steps and the page's own entries finish.
    await Bun.sleep(500);
    expect((await driver.observe(targetId)).target.url).toStartWith(`${provider()}/signin`);
  };
  try {
    targetId = (await driver.start(`${origin}/login`)).target.id;
    const url = async () => (await driver.observe(targetId)).target.url;
    await scenario({ origin, provider, url, run, heading, startFlow });
  } finally {
    await driver.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

e2e(
  "server redirects, a redirected form post and redirects made while a page loads leave one Back step",
  async () => {
    await withFixture(async ({ origin, run, startFlow }) => {
      // Server redirects, a redirected form post and redirects made while
      // the page loads leave no entry of their own: one Back returns.
      for (const [name, role] of [
        ["Continue 302", "link"],
        ["Continue POST", "button"],
        ["Continue href", "link"],
        ["Continue replace", "link"],
      ] as const) {
        await startFlow(name, role);
        const result = await run(back);
        expect(result.error ?? null).toBeNull();
        expect(result.observation?.target.url).toBe(`${origin}/login`);
      }
    });
  },
  60_000,
);

e2e(
  "Back passes over a redirect step that sends the tab on again whenever it is shown",
  async () => {
    await withFixture(async ({ origin, provider, url, run, startFlow }) => {
      // A redirect step that sends the tab on again whenever it is shown:
      // Back passes over it to the login page, and Forward still works.
      await startFlow("Continue step");
      const started = Date.now();
      const stepped = await run(back);
      expect(stepped.error ?? null).toBeNull();
      expect(stepped.state).toBe("completed");
      expect(stepped.observation?.target.url).toBe(`${origin}/login`);
      expect(Date.now() - started).toBeLessThan(8_000);
      const forward = await run({ type: "history", direction: "forward" });
      expect(forward.error ?? null).toBeNull();
      await Bun.sleep(500);
      expect(await url()).toBe(`${provider()}/signin`);
    });
  },
  60_000,
);

e2e(
  "Back leaves a sign-in page that added entries for its own URL as it opened",
  async () => {
    await withFixture(async ({ origin, run, startFlow }) => {
      // Entries for the URL it already shows, which the sign-in page added
      // as it opened: one Back leaves the page.
      await startFlow("Continue same entries");
      const same = await run(back);
      expect(same.error ?? null).toBeNull();
      expect(same.observation?.target.url).toBe(`${origin}/login`);
    });
  },
  60_000,
);

e2e(
  "entries with their own URLs, and one made after input, stay single Back steps",
  async () => {
    await withFixture(async ({ origin, provider, url, run, heading, startFlow }) => {
      // Entries with their own URLs stay single steps, each a visible move.
      await startFlow("Continue path entries");
      expect(await url()).toBe(`${provider()}/signin/identifier`);
      const path = await run(back);
      expect(path.error ?? null).toBeNull();
      expect(path.observation?.target.url).toBe(`${provider()}/signin?entries=paths`);
      expect((await run(back)).observation?.target.url).toBe(`${origin}/login`);

      // An entry for the same URL added after input (a dialog) is one step:
      // Back closes the dialog and stays on the page, as a browser does.
      await startFlow("Continue 302");
      expect(
        (
          await run({
            type: "click",
            locator: { kind: "role", role: "button", name: "Open dialog" },
          })
        ).state,
      ).toBe("completed");
      expect(await heading()).toBe("Dialog");
      const dialog = await run(back);
      expect(dialog.error ?? null).toBeNull();
      expect(dialog.observation?.target.url).toBe(`${provider()}/signin`);
      expect(await heading()).toBe("Sign in");
      expect((await run(back)).observation?.target.url).toBe(`${origin}/login`);
    });
  },
  60_000,
);

e2e(
  "Back says so when the pages before a sign-in page all send the tab on by themselves",
  async () => {
    await withFixture(async ({ origin, run, startFlow }) => {
      // Redirect steps all the way back: Back says so and names the page
      // that works instead of reporting a move that did not happen.
      await startFlow("Continue chain");
      const chain = await run(back);
      expect(chain.state).toBe("failed");
      expect(chain.error?.code).toBe("invalid_action");
      expect(chain.error?.message).toStartWith(
        `going back opened ${origin}/go/chain/1, which went on to `,
      );
      expect(chain.error?.message).toEndWith(
        ` by itself; navigate to the page before it, ${origin}/login, instead`,
      );
      expect((await run({ type: "navigate", url: `${origin}/login` })).state).toBe("completed");
    });
  },
  60_000,
);

e2e(
  "Back to a page restored from the back/forward cache, or one that loads itself again, stays there",
  async () => {
    await withFixture(async ({ origin, url, run, heading }) => {
      expect((await run({ type: "navigate", url: `${origin}/plain/a` })).state).toBe("completed");
      expect((await run({ type: "navigate", url: `${origin}/plain/b` })).state).toBe("completed");
      const restored = await run(back);
      expect(restored.error ?? null).toBeNull();
      expect(restored.observation?.target.url).toBe(`${origin}/plain/a`);
      expect(await heading()).toBe("Restored");
      const forward = await run({ type: "history", direction: "forward" });
      expect(forward.observation?.target.url).toBe(`${origin}/plain/b`);

      expect((await run({ type: "navigate", url: `${origin}/plain/reload` })).state).toBe(
        "completed",
      );
      expect((await run({ type: "navigate", url: `${origin}/plain/b` })).state).toBe("completed");
      const reloaded = await run(back);
      expect(reloaded.error ?? null).toBeNull();
      expect(reloaded.observation?.target.url).toBe(`${origin}/plain/reload`);
      await Bun.sleep(500);
      expect(await url()).toBe(`${origin}/plain/reload`);
      expect(await heading()).toBe("Reloaded");
    });
  },
  60_000,
);
