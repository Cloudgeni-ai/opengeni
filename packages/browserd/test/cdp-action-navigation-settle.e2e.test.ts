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

const page = (title: string, body: string) =>
  new Response(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`, {
    headers: { "content-type": "text/html" },
  });

e2e(
  "the post-action observation shows the document a click navigated to",
  async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        switch (url.pathname) {
          case "/signin":
            if (request.method === "POST") {
              await request.formData();
              await Bun.sleep(300);
              return new Response(null, { status: 303, headers: { location: "/account" } });
            }
            return page(
              "Sign in",
              '<form method="post" action="/signin"><label>Email <input name="email"></label><button type="submit">Sign in</button></form><a href="/slow">Slow page</a><form method="post" action="/noop"><button type="submit">Save draft</button></form>',
            );
          case "/account":
            await Bun.sleep(150);
            return page("Account", "<p>Signed in</p>");
          case "/slow":
            await Bun.sleep(600);
            return page("Slow destination", "<p>Arrived slowly</p>");
          case "/noop":
            await Bun.sleep(100);
            return new Response(null, { status: 204 });
          default:
            return new Response("not found", { status: 404 });
        }
      },
    });
    const directory = await mkdtemp("/tmp/ogb-navigation-settle-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `navsettle_${randomUUID().slice(0, 8)}`,
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
    const click = (
      observation: BrowserObservation,
      role: string,
      name: string,
    ): BrowserActionCommand => ({
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId!,
      actor: { kind: "human", subjectId: "navigation-settle-fixture" },
      observationMode: "full",
      action: { type: "click", locator: { kind: "role", role, name, exact: true } },
    });
    const signin = `http://127.0.0.1:${server.port}/signin`;
    const reopen = async (observation: BrowserObservation) =>
      (
        await controller.run({
          ...click(observation, "button", "unused"),
          action: { type: "navigate", url: signin },
        })
      ).observation!;
    try {
      // A form POST answered with a redirect, as on most sign-in pages.
      const initial = await driver.start(signin);
      const submitted = await controller.run(click(initial, "button", "Sign in"));
      expect(submitted.state).toBe("completed");
      expect(submitted.observation?.target.title).toBe("Account");
      expect(texts(submitted.observation)).toContain("Signed in");

      // A link to a server that is slow to answer.
      const back = await reopen(submitted.observation!);
      const linked = await controller.run(click(back, "link", "Slow page"));
      expect(linked.state).toBe("completed");
      expect(linked.observation?.target.title).toBe("Slow destination");

      // A form answered with 204 No Content leaves the page in place, and the
      // result must not wait out the navigation bound for a document that never comes.
      const again = await reopen(linked.observation!);
      const startedAt = Date.now();
      const kept = await controller.run(click(again, "button", "Save draft"));
      expect(kept.state).toBe("completed");
      expect(kept.observation?.target.title).toBe("Sign in");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
