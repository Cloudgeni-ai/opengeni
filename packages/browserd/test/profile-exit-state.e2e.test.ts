import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markProfileExitedCleanly } from "../src/profile-exit-state";

const executable =
  process.env.OPENGENI_BROWSER_EXECUTABLE ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/chromium");
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" && existsSync(executable) ? test : test.skip;

async function launch(profile: string) {
  const browser = Bun.spawn(
    [
      executable,
      "--headless",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--restore-last-session",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = await readFile(join(profile, "DevToolsActivePort"), "utf8")
      .then((text) => Number.parseInt(text.split("\n")[0]!, 10))
      .catch(() => null);
    if (port && (await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null))?.ok)
      return { browser, port };
    await Bun.sleep(100);
  }
  browser.kill("SIGKILL");
  throw new Error("browser did not start");
}

async function pageUrls(port: number): Promise<string[]> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string;
    url: string;
  }[];
  return targets.filter((target) => target.type === "page").map((target) => target.url);
}

e2e(
  "a profile whose browser was killed restores its tabs once marked as cleanly exited",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new Response(`<title>${new URL(request.url).pathname}</title>`, {
          headers: { "content-type": "text/html" },
        }),
    });
    const profile = await mkdtemp(join(tmpdir(), "browserd-exit-restore-"));
    const pages = ["/first", "/second"].map((path) => `http://127.0.0.1:${server.port}${path}`);
    try {
      const killed = await launch(profile);
      for (const url of pages)
        await fetch(`http://127.0.0.1:${killed.port}/json/new?${url}`, { method: "PUT" });
      // Chromium persists its session and Preferences on timers; wait until
      // both record this run before killing it.
      for (let attempt = 0; attempt < 300; attempt++) {
        const preferences = await readFile(join(profile, "Default", "Preferences"), "utf8").catch(
          () => "",
        );
        if (preferences.includes('"exit_type":"Crashed"')) break;
        await Bun.sleep(100);
      }
      await Bun.sleep(3_000);
      killed.browser.kill("SIGKILL");
      await killed.browser.exited;

      expect(await markProfileExitedCleanly(profile)).toBe(true);
      const relaunched = await launch(profile);
      try {
        let urls: string[] = [];
        for (let attempt = 0; attempt < 50; attempt++) {
          urls = await pageUrls(relaunched.port);
          if (pages.every((url) => urls.includes(url))) break;
          await Bun.sleep(100);
        }
        expect(urls).toEqual(expect.arrayContaining(pages));
      } finally {
        relaunched.browser.kill();
        await relaunched.browser.exited;
      }
    } finally {
      server.stop(true);
      await rm(profile, { recursive: true, force: true });
    }
  },
  60_000,
);
