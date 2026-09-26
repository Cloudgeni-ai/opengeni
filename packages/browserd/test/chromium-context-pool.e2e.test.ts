import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowserJsonRunner, EphemeralChromiumContextPool } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;
e2e(
  "real Chromium pool isolates actor cookies/storage/popups and renders while a peer ends",
  async () => {
    const directory = await mkdtemp("/tmp/ogcp-");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const actor = new URL(request.url).searchParams.get("actor");
        const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
        if (actor) headers.set("set-cookie", `actor=${actor}; HttpOnly; SameSite=Lax; Path=/`);
        return new Response(
          `<!doctype html><title>${actor ?? request.headers.get("cookie") ?? "none"}</title>
      <style>body {font:24px sans-serif;background:#eef6ff}h1 {color:#1654aa}</style>
      <h1>${actor ?? request.headers.get("cookie") ?? "none"}</h1><p id="storage"></p>
      <button onclick="window.open('/check','_blank')">Popup</button>
      <script>${actor ? `localStorage.setItem('actor', ${JSON.stringify(actor)});` : ""}
      document.querySelector('#storage').textContent='Stored '+localStorage.getItem('actor');</script>`,
          { headers },
        );
      },
    });
    const authority = "fixture-owner-fixed-egress";
    const pool = new EphemeralChromiumContextPool({
      authorityKey: authority,
      launch: () =>
        AgentBrowserJsonRunner.create({
          namespace: `c${randomUUID().slice(0, 6)}`,
          sessionName: "s",
          socketDirectory: join(directory, "socket"),
          profileDirectory: join(directory, "profile"),
          downloadDirectory: join(directory, "downloads"),
          screenshotDirectory: join(directory, "screenshots"),
          headed: false,
          ...(process.env.OPENGENI_TEST_CHROME_PATH
            ? { browserExecutablePath: process.env.OPENGENI_TEST_CHROME_PATH }
            : {}),
        }),
    });
    try {
      const actors = await Promise.all(
        ["Alice", "Bob"].map(async (name) => {
          const driver = await pool.createDriver(authority, {
            browserSessionId: randomUUID(),
            controllerGeneration: randomUUID(),
          });
          const observation = await driver.start(`${server.url}?actor=${name}`);
          expect(JSON.stringify(observation)).toContain(`Stored ${name}`);
          return { driver, observation, name };
        }),
      );
      const [a, b] = actors;
      if (!a || !b) throw new Error("missing actors");
      await expect(a.driver.captureScreenshot(b.observation.target.id)).rejects.toThrow(
        "browser target does not exist",
      );
      await expect(a.driver.closeTarget(b.observation.target.id)).rejects.toThrow(
        "browser target does not exist",
      );
      for (const actor of actors) {
        const check = await actor.driver.openTarget(`${server.url}check`);
        expect(check.target.title).toBe(`actor=${actor.name}`);
        expect(JSON.stringify(check)).toContain(`Stored ${actor.name}`);
        const screenshot = await actor.driver.captureScreenshot(check.target.id);
        expect(screenshot.width).toBeGreaterThan(100);
        expect(screenshot.data.byteLength).toBeGreaterThan(1000);
        const observation = actor.observation;
        await actor.driver.dispatch({
          protocolVersion: 1,
          operationId: randomUUID(),
          browserSessionId: observation.browserSessionId,
          controllerGeneration: observation.target.controllerGeneration,
          targetId: observation.target.id,
          expectedTargetGeneration: observation.target.targetGeneration,
          expectedDocumentGeneration: observation.target.documentGeneration,
          expectedFrameId: observation.frameId!,
          actor: { kind: "agent", subjectId: "context-fixture" },
          action: { type: "click", locator: { kind: "role", role: "button", name: "Popup" } },
        });
        expect(await actor.driver.listTargets()).toHaveLength(3);
      }
      await a.driver.close();
      expect(await b.driver.listTargets()).toHaveLength(3);
      expect(
        (await b.driver.captureScreenshot(b.observation.target.id)).data.byteLength,
      ).toBeGreaterThan(1000);
      await b.driver.close();
    } finally {
      await pool.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
