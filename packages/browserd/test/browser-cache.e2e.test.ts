import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { BrowserSupervisor } from "../src";

// Chromium's ~/.cache counterpart of a profile under ~/.config is Linux-only.
const e2e =
  process.env.OPENGENI_BROWSERD_E2E === "1" && process.platform === "linux" ? test : test.skip;

async function present(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/** Every file below `directory`, by path from it. */
async function files(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1));
  } catch {
    return [];
  }
}

e2e(
  "a real Chromium caches inside its session, and the caches go when the browser stops",
  async () => {
    const home = await mkdtemp("/tmp/og-cache-e2e-");
    const previousHome = process.env.HOME;
    // The native agent keeps browser state under ~/.config on Linux.
    process.env.HOME = home;
    const state = ["opengeni", "agent", "browserd", "scopes", "s", "state"];
    const rootDirectory = join(home, ".config", ...state);
    const mirror = (id: string) => join(home, ".cache", ...state, "sessions", id);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/app.js"
          ? new Response(`window.loaded = ${JSON.stringify("x".repeat(256 * 1024))}.length;`, {
              headers: {
                "content-type": "text/javascript",
                "cache-control": "public, max-age=86400",
              },
            })
          : new Response('<!doctype html><title>Cached</title><script src="/app.js"></script>', {
              headers: {
                "content-type": "text/html",
                "cache-control": "public, max-age=86400",
                "set-cookie": "kept=1; Max-Age=86400; Path=/",
              },
            }),
    });
    const supervisor = await BrowserSupervisor.open({ rootDirectory });
    const options = (browserSessionId: string) => ({
      browserSessionId,
      controllerGeneration: randomUUID(),
      headed: false,
      transport: { kind: "managed" as const, engine: "chromium" as const },
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
      initialUrl: `http://127.0.0.1:${server.port}/`,
    });
    try {
      const kept = options(randomUUID());
      await supervisor.createSession(kept);
      const session = join(rootDirectory, "sessions", kept.browserSessionId);
      const cache = join(session, "browser-cache");
      let cached: string[] = [];
      for (let attempt = 0; attempt < 100 && cached.length === 0; attempt += 1) {
        cached = (await files(cache)).filter((path) => path.includes("Cache_Data"));
        if (cached.length === 0) await Bun.sleep(100);
      }
      expect(cached.length).toBeGreaterThan(0);
      // Nothing goes to ~/.cache any more: at most Chromium's empty folders.
      expect(await files(mirror(kept.browserSessionId))).toEqual([]);
      expect(await files(join(session, "profile", "Default", "Cache"))).toEqual([]);

      // An end that keeps the session (a browser whose task moved elsewhere,
      // or an idle stop) keeps the profile for a later resume, not its caches.
      await supervisor.endSession(kept, { removeState: false });
      expect(await present(join(session, "profile", "Default", "Cookies"))).toBe(true);
      expect(await present(join(session, "profile", "Local State"))).toBe(true);
      expect(await present(cache)).toBe(false);
      expect(await present(mirror(kept.browserSessionId))).toBe(false);

      const removed = options(randomUUID());
      await supervisor.createSession(removed);
      await supervisor.endSession(removed, { removeState: true });
      expect(await present(join(rootDirectory, "sessions", removed.browserSessionId))).toBe(false);
      expect(await present(mirror(removed.browserSessionId))).toBe(false);
    } finally {
      await supervisor.close();
      await server.stop(true);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  },
  120_000,
);
