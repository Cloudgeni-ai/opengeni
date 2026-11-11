import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  browserCacheDirectory,
  cacheMirrorDirectories,
  discardBrowserCaches,
  sweepStoppedBrowserCaches,
} from "../src/browser-cache";
import { managedChromeArguments, managedProfileUseInventory } from "../src/runner";

const linux = process.platform === "linux" ? test : test.skip;

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let home: string;
let previousHome: string | undefined;
let sessions: string;
let mirror: string;

beforeEach(async () => {
  home = await mkdtemp("/tmp/ogb-cache-home-");
  previousHome = process.env.HOME;
  // Chromium finds ~/.config and ~/.cache through HOME, as browserd does.
  process.env.HOME = home;
  const state = ["opengeni", "agent", "browserd", "scopes", "s", "state", "sessions"];
  sessions = join(home, ".config", ...state);
  mirror = join(home, ".cache", ...state);
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

async function put(path: string, content = "x"): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false,
  );
}

/** A stopped session as a browser leaves it: profile state the next resume
 * needs, controller journals and downloads, plus caches that are disposable. */
async function stoppedSession(name: string): Promise<void> {
  const session = join(sessions, name);
  await put(join(session, "profile", "Default", "Cookies"), "cookies");
  await put(join(session, "profile", "Default", "Local Storage", "leveldb", "000003.log"), "ls");
  await put(join(session, "profile", "Local State"), "{}");
  await put(join(session, "working-runtime.sqlite"), "journal");
  await put(join(session, "downloads", "report.pdf"), "pdf");
  await put(join(session, "browser-cache", "Default", "Cache", "Cache_Data", "data_0"));
  await put(join(session, "browser-cache", "Default", "Code Cache", "js", "index"));
  // Launches before the cache directory was named, off Linux ~/.config.
  await put(join(session, "profile", "Default", "Cache", "Cache_Data", "data_1"));
  await put(join(session, "profile", "Default", "Code Cache", "wasm", "index"));
  // Launches before the cache directory was named, on Linux under ~/.config.
  await put(join(mirror, name, "profile", "Default", "Cache", "Cache_Data", "data_2"));
}

async function expectStateKept(name: string): Promise<void> {
  const session = join(sessions, name);
  for (const path of [
    join(session, "profile", "Default", "Cookies"),
    join(session, "profile", "Default", "Local Storage", "leveldb", "000003.log"),
    join(session, "profile", "Local State"),
    join(session, "working-runtime.sqlite"),
    join(session, "downloads", "report.pdf"),
  ]) {
    expect(await exists(path)).toBe(true);
  }
}

async function cachesGone(name: string): Promise<boolean> {
  const session = join(sessions, name);
  const remaining = await Promise.all(
    [
      join(session, "browser-cache"),
      join(session, "profile", "Default", "Cache"),
      join(session, "profile", "Default", "Code Cache"),
      join(mirror, name),
    ].map(exists),
  );
  return remaining.every((present) => !present);
}

describe("browser caches", () => {
  test("launches keep Chromium's caches next to the profile, inside the session", () => {
    const profile = join(sessions, A, "profile");
    const argumentsList = managedChromeArguments({
      platform: "linux",
      windowed: false,
      profileDirectory: profile,
      proxyServer: null,
    });
    expect(browserCacheDirectory(profile)).toBe(join(sessions, A, "browser-cache"));
    expect(argumentsList).toContain(`--disk-cache-dir=${join(sessions, A, "browser-cache")}`);
    expect(argumentsList).toContain(`--user-data-dir=${profile}`);
  });

  linux("finds Chromium's ~/.cache counterpart only for sessions under ~/.config", async () => {
    expect(await cacheMirrorDirectories(sessions)).toEqual([mirror]);
    expect(await cacheMirrorDirectories(join(home, "elsewhere", "sessions"))).toEqual([]);
    expect(await cacheMirrorDirectories(join(home, ".config"))).toEqual([]);
  });

  linux("a stopped browser loses its caches and keeps everything a resume needs", async () => {
    await stoppedSession(A);
    await stoppedSession(B);
    await discardBrowserCaches(join(sessions, A));
    expect(await cachesGone(A)).toBe(true);
    await expectStateKept(A);
    // Another session is not touched.
    expect(await exists(join(sessions, B, "browser-cache"))).toBe(true);
    expect(await exists(join(mirror, B))).toBe(true);
  });

  linux("a removed session directory loses its ~/.cache counterpart too", async () => {
    await stoppedSession(A);
    await rm(join(sessions, A), { recursive: true });
    await discardBrowserCaches(join(sessions, A));
    expect(await exists(join(mirror, A))).toBe(false);
  });

  linux("never follows a link out of the session directory", async () => {
    const outside = join(home, "outside");
    await put(join(outside, "Cache", "keep"), "not ours");
    await mkdir(join(sessions, A, "profile"), { recursive: true });
    await symlink(outside, join(sessions, A, "profile", "Default"));
    await discardBrowserCaches(join(sessions, A));
    expect(await exists(join(outside, "Cache", "keep"))).toBe(true);
  });

  linux("startup drops caches of stopped browsers and of sessions that already ended", async () => {
    await stoppedSession(A); // stopped, kept for a later resume
    await stoppedSession(B); // a browser still runs on it
    await stoppedSession(C); // this controller holds it
    await put(join(mirror, D, "profile", "Default", "Cache", "Cache_Data", "data_0")); // ended
    await put(join(mirror, E, "profile", "Default", "Code Cache", "js", "index")); // being created
    const running = new Set([join(sessions, B, "profile")]);
    const removed = await sweepStoppedBrowserCaches({
      sessionsDirectory: sessions,
      busy: (name) => name === C || name === E,
      profileInUse: async () => (profile) => running.has(profile),
      stopped: () => false,
    });
    expect(removed.sort()).toEqual([A, D]);
    expect(await cachesGone(A)).toBe(true);
    await expectStateKept(A);
    expect(await exists(join(mirror, D))).toBe(false);
    for (const name of [B, C]) {
      expect(await exists(join(sessions, name, "browser-cache"))).toBe(true);
      expect(await exists(join(mirror, name))).toBe(true);
      await expectStateKept(name);
    }
    expect(await exists(join(mirror, E))).toBe(true);
  });

  linux("without a process inventory only sessions that ended lose their caches", async () => {
    await stoppedSession(A);
    await put(join(mirror, D, "profile", "Default", "Cache", "Cache_Data", "data_0"));
    const removed = await sweepStoppedBrowserCaches({
      sessionsDirectory: sessions,
      busy: () => false,
      profileInUse: async () => null,
      stopped: () => false,
    });
    expect(removed).toEqual([D]);
    expect(await exists(join(sessions, A, "browser-cache"))).toBe(true);
    expect(await exists(join(mirror, A))).toBe(true);
  });

  linux("the process inventory recognizes a browser by its exact profile", async () => {
    const profile = join(sessions, A, "profile");
    const holder = Bun.spawn(["sh", "-c", "sleep 30", "sh", `--user-data-dir=${profile}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      let inUse: ((profileDirectory: string) => boolean) | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        inUse = await managedProfileUseInventory();
        if (inUse?.(profile)) break;
        await Bun.sleep(20);
      }
      expect(inUse?.(profile)).toBe(true);
      expect(inUse?.(join(sessions, B, "profile"))).toBe(false);
    } finally {
      holder.kill();
      await holder.exited;
    }
  });
});
