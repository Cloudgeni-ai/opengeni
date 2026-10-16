import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { BrowserSupervisor, CdpConnection } from "../src";

const e2e =
  process.env.OPENGENI_BROWSERD_E2E === "1" &&
  (process.platform === "darwin" || process.platform === "linux")
    ? test
    : test.skip;

e2e(
  "a headless managed browser presents an ordinary Chrome User-Agent and a desktop screen",
  async () => {
    const root = await mkdtemp("/tmp/og-headless-ua-");
    const sockets = await mkdtemp("/tmp/og-headless-ua-s-");
    const supervisor = await BrowserSupervisor.open({
      rootDirectory: root,
      socketRootDirectory: sockets,
    });
    const reference = {
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
    };
    // Loopback HTTP is a secure context, so User-Agent Client Hints exist.
    const userAgents: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        userAgents.push(request.headers.get("user-agent") ?? "");
        return new Response("<h1>Headless</h1>", { headers: { "content-type": "text/html" } });
      },
    });
    try {
      const created = await supervisor.createSession({
        ...reference,
        headed: false,
        transport: { kind: "managed", engine: "chromium" },
        ...(process.env.OPENGENI_BROWSER_EXECUTABLE
          ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
          : {}),
        initialUrl: `http://127.0.0.1:${server.port}/`,
      });
      const profileDirectory = join(root, "sessions", reference.browserSessionId, "profile");
      const [port, path] = (await readFile(join(profileDirectory, "DevToolsActivePort"), "utf8"))
        .trim()
        .split("\n");
      const connection = await CdpConnection.connect(`ws://127.0.0.1:${port}${path}`);
      try {
        const attached = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
          targetId: created.observation.target.id,
          flatten: true,
        });
        const evaluated = await connection.send<{ result: { value: string } }>(
          "Runtime.evaluate",
          {
            expression:
              "JSON.stringify({ua: navigator.userAgent, brands: navigator.userAgentData.brands.map((b) => b.brand), webdriver: navigator.webdriver, width: screen.width, availHeight: screen.availHeight, height: screen.height})",
            returnByValue: true,
          },
          { sessionId: attached.sessionId },
        );
        const page = JSON.parse(evaluated.result.value) as {
          ua: string;
          brands: string[];
          webdriver: boolean;
          width: number;
          height: number;
          availHeight: number;
        };
        expect(page.ua).not.toContain("Headless");
        expect(page.ua).toMatch(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/u);
        expect(page.brands.join("|")).not.toContain("Headless");
        expect(page.webdriver).toBe(false);
        expect(page.width).not.toBe(800);
        expect(page.availHeight).toBeLessThan(page.height);
      } finally {
        connection.close();
      }
      // The HTTP User-Agent header matches what the page reports.
      expect(userAgents.length).toBeGreaterThan(0);
      for (const header of userAgents) expect(header).not.toContain("Headless");
      await supervisor.endSession(reference, { removeState: true });
    } finally {
      await supervisor.endSession(reference, { removeState: true }).catch(() => undefined);
      await supervisor.close();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
      await rm(sockets, { recursive: true, force: true });
    }
  },
  60_000,
);
