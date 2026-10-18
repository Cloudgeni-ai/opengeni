import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  resolvePinnedAgentBrowserBinary,
} from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

function texts(observation: BrowserObservation | null | undefined): string {
  const semantic = observation?.semantic;
  const pending: InteractionSemanticNodeValue[] =
    semantic?.kind === "snapshot" ? [...semantic.roots] : [];
  const found: string[] = [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.name) found.push(node.name);
    if (node.children) pending.push(...node.children);
  }
  return found.join("\n");
}

e2e(
  "the post-action observation includes the page update from a request the action started",
  async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/submit") {
          await Bun.sleep(300);
          return Response.json({ ok: true });
        }
        // Never answers: an open stream or a stalled server.
        if (path === "/stalled") return new Response(new ReadableStream({ start() {} }));
        return new Response(
          '<!doctype html><title>Request settle</title><button id="save">Save</button><button id="stall">Stall</button><div role="status" id="result"></div><script>save.onclick=async()=>{const r=await fetch("/submit",{method:"POST"});result.textContent=(await r.json()).ok?"Submitted. Thank you!":"Failed"};stall.onclick=()=>{fetch("/stalled");result.textContent="Waiting for partner"}</script>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const directory = await mkdtemp("/tmp/ogb-request-settle-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `settle_${randomUUID().slice(0, 8)}`,
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
    const command = (observation: BrowserObservation, name: string): BrowserActionCommand => ({
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId!,
      actor: { kind: "human", subjectId: "request-settle-fixture" },
      observationMode: "full",
      action: { type: "click", locator: { kind: "role", role: "button", name, exact: true } },
    });
    try {
      const initial = await driver.start(`http://127.0.0.1:${server.port}/`);

      const saved = await controller.run(command(initial, "Save"));
      expect(saved.state).toBe("completed");
      // The response arrives after the click; the result must already show it.
      expect(texts(saved.observation)).toContain("Submitted. Thank you!");

      // A request that never finishes is waited for only up to a short bound.
      const startedAt = Date.now();
      const stalled = await controller.run(command(saved.observation!, "Stall"));
      expect(stalled.state).toBe("completed");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(texts(stalled.observation)).toContain("Waiting for partner");
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
