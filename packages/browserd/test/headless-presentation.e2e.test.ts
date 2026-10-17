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

e2e(
  "a headless managed browser reports complete Client Hints on every page, frame and worker",
  async () => {
    const root = await mkdtemp("/tmp/og-headless-ch-");
    const sockets = await mkdtemp("/tmp/og-headless-ch-s-");
    const supervisor = await BrowserSupervisor.open({
      rootDirectory: root,
      socketRootDirectory: sockets,
    });
    const reference = {
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
    };
    type HighEntropy = {
      architecture: string;
      bitness: string;
      platformVersion: string;
      uaFullVersion: string;
      fullVersionList: Array<{ brand: string; version: string }>;
      formFactors: string[];
    };
    const reports = new Map<string, HighEntropy>();
    const hintHeaders: Array<{ platformVersion: string; arch: string; fullVersionList: string }> =
      [];
    const askHints = {
      "accept-ch": "Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Full-Version-List",
      "critical-ch": "Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Full-Version-List",
    };
    const reporter = (scope: string) => `(async () => {
      const values = await navigator.userAgentData.getHighEntropyValues([
        "architecture", "bitness", "formFactors", "fullVersionList", "platformVersion", "uaFullVersion",
      ]);
      await fetch(REPORT, { method: "POST", body: JSON.stringify({ scope: ${JSON.stringify(scope)}, values }) });
    })();`;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const platformVersion = request.headers.get("sec-ch-ua-platform-version");
        if (platformVersion !== null)
          hintHeaders.push({
            platformVersion,
            arch: request.headers.get("sec-ch-ua-arch") ?? "",
            fullVersionList: request.headers.get("sec-ch-ua-full-version-list") ?? "",
          });
        const report = `const REPORT = "http://127.0.0.1:${url.port}/report";`;
        const cors = { "access-control-allow-origin": "*" };
        if (url.pathname === "/report") {
          const body = (await request.json()) as { scope: string; values: HighEntropy };
          reports.set(body.scope, body.values);
          return new Response("", { headers: cors });
        }
        if (url.pathname === "/worker.js") {
          return new Response(report + reporter(url.searchParams.get("scope") ?? "worker"), {
            headers: { "content-type": "text/javascript", ...askHints },
          });
        }
        if (url.pathname === "/frame") {
          return new Response(`<script>${report}${reporter("cross-site frame")}</script>`, {
            headers: { "content-type": "text/html", ...askHints },
          });
        }
        // localhost and 127.0.0.1 are different sites, so the frame runs out of process.
        return new Response(
          `<h1>Hints</h1><iframe src="http://localhost:${url.port}/frame"></iframe><script>${report}${reporter("page")}
          new Worker("/worker.js?scope=dedicated");
          new SharedWorker("/worker.js?scope=shared");
          navigator.serviceWorker.register("/worker.js?scope=service");
          </script>`,
          { headers: { "content-type": "text/html", ...askHints } },
        );
      },
    });
    try {
      await supervisor.createSession({
        ...reference,
        headed: false,
        transport: { kind: "managed", engine: "chromium" },
        ...(process.env.OPENGENI_BROWSER_EXECUTABLE
          ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
          : {}),
        initialUrl: `http://127.0.0.1:${server.port}/`,
      });
      const scopes = ["page", "cross-site frame", "dedicated", "shared", "service"];
      const deadline = Date.now() + 15_000;
      while (scopes.some((scope) => !reports.has(scope)) && Date.now() < deadline)
        await Bun.sleep(100);
      expect([...reports.keys()].sort()).toEqual([...scopes].sort());
      for (const [scope, values] of reports) {
        expect({ scope, architecture: values.architecture }).toEqual({
          scope,
          architecture: expect.stringMatching(/^(arm|x86)$/u),
        });
        expect({ scope, bitness: values.bitness }).toEqual({ scope, bitness: "64" });
        expect({ scope, platformVersion: values.platformVersion }).toEqual({
          scope,
          platformVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        });
        expect({ scope, uaFullVersion: values.uaFullVersion }).toEqual({
          scope,
          uaFullVersion: expect.stringMatching(/^\d+\.0\.\d+\.\d+$/u),
        });
        expect(values.fullVersionList.map((entry) => entry.version)).toContain(
          values.uaFullVersion,
        );
        expect(values.formFactors).toEqual(["Desktop"]);
      }
      // Requests carry the same hints, never Chrome's empty ones.
      expect(hintHeaders.length).toBeGreaterThan(0);
      for (const header of hintHeaders) {
        expect(header.platformVersion).toMatch(/^"\d+\.\d+\.\d+"$/u);
        expect(header.arch).toMatch(/^"(arm|x86)"$/u);
        expect(header.fullVersionList).toContain(reports.get("page")!.uaFullVersion);
      }
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
