import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

// Some sites show a stored password in an ordinary text input labelled
// "Password". Its value must stay out of semantic outlines and DOM reads
// exactly like an `<input type=password>`'s. Synthetic values only.
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const SECRETS = [
  "synthetic-for-4711",
  "synthetic-wrap-4712",
  "synthetic-aria-4713",
  "synthetic-shadow-4714",
];

const PAGE = `<!doctype html><title>Review login</title>
<h1>Review login details</h1>
<label for="user">Username</label><input id="user" type="text" value="reviewer@example.test">
<label for="pw">Password</label><input id="pw" type="text" value="${SECRETS[0]}">
<label>Backup password <input id="wrapped" type="text" value="${SECRETS[1]}"></label>
<span id="pin-label">Passord</span><input id="labelled" aria-labelledby="pin-label" type="text" value="${SECRETS[2]}">
<div id="host"></div>
<script>
const root = document.getElementById("host").attachShadow({ mode: "closed" });
root.innerHTML = '<label for="inner">Password</label><input id="inner" type="text" value="${SECRETS[3]}">';
</script>`;

e2e(
  "a plain text field labelled as a password stays out of outlines and DOM reads",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }),
    });
    const directory = await mkdtemp("/tmp/ogb-password-labelled-text-");
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
      const started = await driver.start(`http://127.0.0.1:${server.port}/`);
      const observation = await driver.observe(started.target.id);
      const outline = JSON.stringify(observation.semantic);
      for (const secret of SECRETS) expect(outline).not.toContain(secret);
      expect(outline).toContain('"reason":"password"');
      // Ordinary fields and the labels themselves stay readable.
      expect(outline).toContain("reviewer@example.test");
      expect(outline).toContain("Backup password");
      const state = await driver.targetState(started.target.id);
      for (const selector of ["#pw", "#wrapped", "#labelled"]) {
        const dom = await driver.readDom(started.target.id, {
          kind: "element",
          locator: { kind: "css", selector },
          expectedTargetGeneration: state.targetGeneration,
          expectedDocumentGeneration: state.documentGeneration!,
          expectedFrameId: state.frameId!,
        });
        expect(dom).toMatchObject({ value: null, redacted: "password" });
      }
      const user = await driver.readDom(started.target.id, {
        kind: "element",
        locator: { kind: "css", selector: "#user" },
        expectedTargetGeneration: state.targetGeneration,
        expectedDocumentGeneration: state.documentGeneration!,
        expectedFrameId: state.frameId!,
      });
      expect(JSON.stringify(user)).toContain("reviewer@example.test");
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
