import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { BrowserSupervisor, CdpConnection } from "../src";

const e2e =
  process.env.OPENGENI_BROWSERD_E2E === "1" && process.platform === "darwin" ? test : test.skip;

function output(command: string, args: readonly string[]): string {
  return spawnSync(command, args, { encoding: "utf8" }).stdout.trim();
}

function frontmostApplication(): string {
  return output("/usr/bin/lsappinfo", [
    "info",
    "-only",
    "name",
    output("/usr/bin/lsappinfo", ["front"]),
  ]);
}

function profileBrowserPids(profileDirectory: string): number[] {
  return output("/bin/ps", ["-axo", "pid=,command="])
    .split("\n")
    .filter((line) => line.includes(`--user-data-dir=${profileDirectory}`))
    .filter((line) => !line.includes("--type="))
    .map((line) => Number.parseInt(line.trim(), 10));
}

e2e(
  "a headed managed browser on macOS runs offscreen: no app, no window, no focus change",
  async () => {
    const root = await mkdtemp("/tmp/og-offscreen-");
    const sockets = await mkdtemp("/tmp/og-offscreen-s-");
    const supervisor = await BrowserSupervisor.open({
      rootDirectory: root,
      socketRootDirectory: sockets,
    });
    const reference = {
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
    };
    const frontBefore = frontmostApplication();
    try {
      const created = await supervisor.createSession({
        ...reference,
        headed: true,
        transport: { kind: "managed", engine: "chromium" },
        ...(process.env.OPENGENI_BROWSER_EXECUTABLE
          ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
          : {}),
        initialUrl: "data:text/html,<h1>Offscreen</h1>",
      });
      const profileDirectory = join(root, "sessions", reference.browserSessionId, "profile");
      const [pid] = profileBrowserPids(profileDirectory);
      expect(pid).toBeGreaterThan(0);
      // A process LaunchServices does not know is not an application: it has
      // no Dock icon, no menu bar and no windows the person can see.
      expect(output("/usr/bin/lsappinfo", ["info", "-only", "name", `${pid}`])).toBe("");
      expect(frontmostApplication()).toBe(frontBefore);

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
              "JSON.stringify({ua: navigator.userAgent, brands: navigator.userAgentData.brands.map((b) => b.brand), webdriver: navigator.webdriver, width: screen.width, availHeight: screen.availHeight, height: screen.height, focus: document.hasFocus(), visibility: document.visibilityState})",
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
          focus: boolean;
          visibility: string;
        };
        expect(page.ua).not.toContain("Headless");
        expect(page.ua).toMatch(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/u);
        expect(page.brands.join("|")).not.toContain("Headless");
        expect(page.webdriver).toBe(false);
        expect(page.width).not.toBe(800);
        expect(page.availHeight).toBeLessThan(page.height);
        expect(page.focus).toBe(true);
        expect(page.visibility).toBe("visible");
      } finally {
        connection.close();
      }
      expect(
        (await supervisor.screenshot(reference, created.observation.target.id)).data.byteLength,
      ).toBeGreaterThan(1000);
      expect(frontmostApplication()).toBe(frontBefore);
      await supervisor.endSession(reference, { removeState: true });
      expect(profileBrowserPids(profileDirectory)).toEqual([]);
    } finally {
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
      await rm(sockets, { recursive: true, force: true });
    }
  },
  60_000,
);
