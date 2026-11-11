import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAction, BrowserObservation } from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { BrowserPasskeyManager } from "../src/passkeys";

// A passkey request the browser answers with its own prompt holds the tab's
// input: clicks on the page never arrive. Without a virtual authenticator the
// click must say so plainly; with one, a request no authenticator can answer
// stays pending without holding input, so the page's own way out works.
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const page = (transports: string) => `<!doctype html><title>Passkey</title><body>
<p id="state">Waiting for passkey</p>
<button id="another">Try another way</button>
<script>
const abort = new AbortController();
document.getElementById("another").onclick = () => { abort.abort(); document.getElementById("state").textContent = "Choose another way"; };
navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: "localhost", allowCredentials: [{ type: "public-key", id: new Uint8Array(16).fill(7), transports: ${transports} }], userVerification: "required", timeout: 120000 }, signal: abort.signal }).catch(() => undefined);
</script></body>`;

async function clickTryAnotherWay(options: { passkeys: boolean; transports: string }) {
  const server = Bun.serve({
    hostname: "localhost",
    port: 0,
    fetch: () =>
      new Response(page(options.transports), {
        headers: { "content-type": "text/html" },
      }),
  });
  const directory = await mkdtemp("/tmp/ogb-passkey-prompt-click-");
  const runner = await ManagedBrowserRunner.create({
    profileDirectory: join(directory, "profile"),
    headed: false,
    ...(process.env.OPENGENI_BROWSER_EXECUTABLE
      ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
      : {}),
  });
  const browserSessionId = randomUUID();
  const controllerGeneration = `controller-${randomUUID()}`;
  const driver = new AgentBrowserDriver({
    browserSessionId,
    controllerGeneration,
    runner,
    ...(options.passkeys
      ? {
          passkeys: new BrowserPasskeyManager({
            browserSessionId,
            controllerGeneration,
          }),
        }
      : {}),
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
      actor: { kind: "agent", subjectId: "passkey-prompt-click" },
      action,
    });
  const stateText = async (targetId: string) =>
    JSON.stringify((await driver.observe(targetId)).semantic).match(
      /Waiting for passkey|Choose another way/,
    )?.[0];
  try {
    const started = await driver.start(`http://localhost:${server.port}/`);
    await Bun.sleep(500);
    const before = await driver.observe(started.target.id);
    expect(JSON.stringify(before.semantic)).toContain("Waiting for passkey");
    let error: unknown = null;
    try {
      await act(before, {
        type: "click",
        locator: { kind: "role", role: "button", name: "Try another way" },
      });
    } catch (caught) {
      error = caught;
    }
    await Bun.sleep(300);
    return { error, state: await stateText(started.target.id) };
  } finally {
    await driver.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

e2e(
  "a click the browser's passkey prompt holds back says the page never received it",
  async () => {
    const { error, state } = await clickTryAnotherWay({
      passkeys: false,
      transports: '["internal"]',
    });
    expect(error).toMatchObject({ code: "outcome_unknown" });
    expect(String((error as Error).message)).toContain("the page never received the press");
    expect(String((error as Error).message)).toContain("passkey");
    expect(state).toBe("Waiting for passkey");
  },
  120_000,
);

e2e(
  "with the virtual authenticator a pending passkey request does not hold page input",
  async () => {
    const { error, state } = await clickTryAnotherWay({
      passkeys: true,
      transports: '["hybrid"]',
    });
    expect(error).toBeNull();
    expect(state).toBe("Choose another way");
  },
  120_000,
);
