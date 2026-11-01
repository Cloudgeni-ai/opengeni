import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAction, BrowserObservation } from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

// A one-time-code field that submits itself once complete: the fill's own
// input navigates the page before the fill can read the field back. The
// fill reached the page, so it reports done with the page it led to, not a
// raw "Cannot find context" failure. Synthetic codes only.
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const pages: Record<string, string> = {
  "/": `<!doctype html><title>Verify</title><label for="code">Code</label>
<input id="code" autocomplete="off" inputmode="numeric">
<script>
document.getElementById("code").addEventListener("input", (event) => {
  if (event.target.value.length === 6) location.href = "/done?ok=1";
});
</script>`,
  "/reload": `<!doctype html><title>Verify</title><label for="code">Code</label>
<input id="code" autocomplete="off">
<script>
document.getElementById("code").addEventListener("input", (event) => {
  if (event.target.value.length === 6) document.body.innerHTML = "<h1>Signed in</h1>";
});
</script>`,
  "/done": `<!doctype html><title>Signed in</title><h1>Signed in</h1>`,
};

e2e(
  "a fill whose input navigates the page reports done with the new page",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new Response(pages[new URL(request.url).pathname] ?? "not found", {
          headers: { "content-type": "text/html" },
        }),
    });
    const directory = await mkdtemp("/tmp/ogb-fill-navigates-");
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
    const act = async (observation: BrowserObservation, action: BrowserAction) =>
      await driver.dispatch({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: observation.browserSessionId,
        controllerGeneration: observation.target.controllerGeneration,
        targetId: observation.target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration,
        expectedFrameId: observation.frameId!,
        actor: { kind: "agent", subjectId: "fill-navigates" },
        action,
      });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const started = await driver.start(`${origin}/`);
      const navigated = await act(await driver.observe(started.target.id), {
        type: "fill",
        locator: { kind: "label", text: "Code", exact: true },
        value: "123456",
      });
      expect(JSON.stringify(navigated.target)).toContain("/done?ok=1");
      expect(JSON.stringify(navigated.semantic)).toContain("Signed in");

      // A field the page removes in reaction to the fill is not a lost value.
      const reloaded = await driver.openTarget(`${origin}/reload`);
      const replaced = await act(await driver.observe(reloaded.target.id), {
        type: "fill",
        locator: { kind: "label", text: "Code", exact: true },
        value: "654321",
      });
      expect(JSON.stringify(replaced.semantic)).toContain("Signed in");
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
