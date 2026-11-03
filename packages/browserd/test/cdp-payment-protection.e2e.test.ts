import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;
// Public synthetic fixtures, never a live payment profile.
const GROUPED = "4000 0000 0000 0002";
const CVC = "731";

function paymentContentJson(value: unknown, ...fixtureOrigins: string[]): string {
  return JSON.stringify(value, (key, item: unknown) => {
    // Generated refs and the fixture's random port are not page content.
    // Keep every other string, including URL paths and queries, under test.
    if (key === "ref") return "<element-ref>";
    return typeof item === "string"
      ? fixtureOrigins.reduce((text, origin) => text.replaceAll(origin, "<fixture-origin>"), item)
      : item;
  });
}

for (const crossOrigin of [false, true]) {
  e2e(
    `payment field values in a ${crossOrigin ? "cross-origin" : "same-origin"} frame stay hidden, and images are never refused`,
    async () => {
      const directory = await mkdtemp("/tmp/ogb-payment-frame-");
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request): Response {
          const frame = new URL(request.url).pathname === "/frame";
          const page = frame
            ? `<label>Embedded card <input autocomplete="cc-number" value="${GROUPED}"></label>
        <label>Embedded security code <input autocomplete="cc-csc" value="${CVC}"></label>
        <button>Pay</button>`
            : `<title>Embedded checkout</title><h1>Public heading</h1><iframe src="http://${crossOrigin ? "localhost" : "127.0.0.1"}:${server.port}/frame"></iframe>`;
          return new Response(page, { headers: { "content-type": "text/html" } });
        },
      });
      const runner = await ManagedBrowserRunner.create({
        profileDirectory: join(directory, "profile"),
        headed: false,
        launchArguments: ["--site-per-process"],
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
        const observation = await driver.start(String(server.url));
        const text = paymentContentJson(
          observation.semantic,
          server.url.origin,
          `http://localhost:${server.port}`,
        );
        for (const secret of [GROUPED, CVC]) expect(text).not.toContain(secret);
        expect(text).toContain("Embedded card");
        expect(text).toContain("Embedded security code");
        expect(text).toContain("Public heading");
        // Field values are left out of page reads; pixels are the person's
        // own screen and are never refused.
        const screenshot = await driver.captureScreenshot(observation.target.id);
        expect(screenshot.data.byteLength).toBeGreaterThan(100);
        let frames = 0;
        const stop = await driver.recordFrames(
          observation.target.id,
          () => {
            frames += 1;
          },
          () => undefined,
        );
        for (let waited = 0; frames === 0 && waited < 5_000; waited += 100) await Bun.sleep(100);
        await stop();
        expect(frames).toBeGreaterThan(0);
      } finally {
        await driver.close();
        server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    },
    90_000,
  );
}

