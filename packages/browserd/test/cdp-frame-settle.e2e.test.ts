import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const html = (body: string) =>
  new Response(`<!doctype html>${body}`, { headers: { "content-type": "text/html" } });

/** A page that keeps replacing its iframe for `ms` milliseconds after it
 * loads, as a page that is still loading its embedded frames does. */
const churningPage = (ms: number) =>
  html(`<title>Loading</title><p>Still loading</p><div id="slot"></div><script>
  const until = Date.now() + ${ms};
  const timer = setInterval(() => {
    if (Date.now() > until) return clearInterval(timer);
    const slot = document.getElementById("slot");
    const frame = document.createElement("iframe");
    frame.src = "/frame?" + Math.random();
    slot.replaceChildren(frame);
  }, 5);
  </script>`);

e2e(
  "a page still loading its frames is observed once they settle, not refused",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/frame") return html("<p>Embedded</p>");
        if (url.pathname === "/settling") return churningPage(500);
        return html("<title>Start</title><p>Start</p>");
      },
    });
    const directory = await mkdtemp("/tmp/ogb-frame-settle-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
    });
    try {
      await driver.start(`http://127.0.0.1:${server.port}/`);
      const observeWhileChanging = async (path: string) => {
        try {
          const opened = await driver.openTarget(`http://127.0.0.1:${server.port}${path}`);
          // Its frames are now changing every few milliseconds.
          await Bun.sleep(60);
          return await driver.observe(opened.target.id);
        } catch (error) {
          return error;
        }
      };
      for (let run = 0; run < 6; run += 1) {
        const observed = await observeWhileChanging("/settling");
        expect(observed).not.toBeInstanceOf(Error);
      }
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
