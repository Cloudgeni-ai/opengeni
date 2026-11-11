import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Chromium's disposable caches for a managed browser's private profile.
 *
 * A managed browser keeps everything a later resume, a saved identity or a
 * reattach needs (cookies, logins, site storage, tabs) in its profile. Its
 * HTTP and compiled-code caches are only a speed-up: a checkpoint never
 * carries them (see state-artifact), so they are useless once the browser has
 * stopped. Launches name their cache directory explicitly, next to the
 * profile inside the session directory, so the caches go when the session
 * directory is removed and can be dropped on their own when the browser stops
 * but its session is kept.
 *
 * Without that switch, Chromium on Linux puts the caches of a profile that
 * lives under ~/.config at the same path under ~/.cache, outside the session
 * directory, where nothing ever removed them. Launches since the switch still
 * leave an empty directory there. Both are removed with the session's caches.
 */
export const BROWSER_CACHE_DIRECTORY = "browser-cache";

/** Where earlier launches, which named no cache directory, kept the caches in
 * the profile itself (any platform but Linux under ~/.config). */
const PROFILE_CACHE_DIRECTORIES = ["Cache", "Code Cache"] as const;

const SESSION_DIRECTORY_NAME = /^[0-9a-f-]{36}$/iu;

/** The cache directory a browser on `profileDirectory` is launched with. */
export function browserCacheDirectory(profileDirectory: string): string {
  return join(dirname(resolve(profileDirectory)), BROWSER_CACHE_DIRECTORY);
}

/** Chromium's ~/.cache counterparts of `sessionsDirectory` on Linux: where it
 * kept the caches of profiles under ~/.config when no cache directory was
 * named. Chromium compares the profile path with $HOME/.config (browserd
 * passes HOME, not the XDG variables, to the browser), so both the path as
 * given and its canonical form are considered. Empty elsewhere. */
export async function cacheMirrorDirectories(sessionsDirectory: string): Promise<string[]> {
  if (process.platform !== "linux") return [];
  // The HOME a launch passes on, as Chromium reads it; its own fallback
  // without one is the account's home directory.
  const home = process.env.HOME || homedir();
  if (!home || !isAbsolute(home)) return [];
  const config = join(home, ".config");
  const cache = join(home, ".cache");
  const sessions = new Set([resolve(sessionsDirectory)]);
  try {
    sessions.add(await realpath(sessionsDirectory));
  } catch {
    // A missing directory has only the path as given.
  }
  const mirrors: string[] = [];
  for (const path of sessions) {
    const below = relative(config, path);
    if (!below || below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) continue;
    const mirror = join(cache, below);
    if (await containsAny(mirror, sessions)) continue;
    if (!mirrors.includes(mirror)) mirrors.push(mirror);
  }
  return mirrors;
}

/** Never treat a directory that is, or holds, the real sessions directory as
 * its cache counterpart (an unusual ~/.cache or ~/.config link could do that). */
async function containsAny(mirror: string, sessions: ReadonlySet<string>): Promise<boolean> {
  const forms = new Set([mirror]);
  try {
    forms.add(await realpath(mirror));
  } catch {
    // Not there (yet): the path as given decides.
  }
  for (const form of forms) {
    for (const session of sessions) {
      if (session === form || session.startsWith(`${form}${sep}`)) return true;
    }
  }
  return false;
}

/** Remove the disposable caches of the browser session at `sessionDirectory`
 * once its browser has stopped: its cache directory, caches earlier launches
 * kept in the profile, and its ~/.cache counterpart. Everything else in the
 * session (profile state, journals, downloads) is untouched. A session
 * directory that was already removed only loses its ~/.cache counterpart. */
export async function discardBrowserCaches(sessionDirectory: string): Promise<void> {
  const directory = resolve(sessionDirectory);
  await removeInside(directory, [BROWSER_CACHE_DIRECTORY]);
  for (const name of PROFILE_CACHE_DIRECTORIES) {
    await removeInside(directory, ["profile", "Default", name]);
  }
  const name = basename(directory);
  if (!SESSION_DIRECTORY_NAME.test(name)) return;
  for (const mirror of await cacheMirrorDirectories(dirname(directory))) {
    await rm(join(mirror, name), { recursive: true, force: true });
  }
}

/** Remove `root/...segments` without following a link on the way: an
 * intermediate entry that is not a plain directory leaves everything alone. */
async function removeInside(root: string, segments: readonly string[]): Promise<void> {
  let path = root;
  for (const segment of segments.slice(0, -1)) {
    path = join(path, segment);
    try {
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  await rm(join(path, segments.at(-1)!), { recursive: true, force: true });
}

export type BrowserCacheSweep = {
  /** Root sessions directory (`<state>/sessions`). */
  sessionsDirectory: string;
  /** A session this controller holds or is acting on right now. */
  busy(name: string): boolean;
  /** One process inventory, taken after the directories were listed: whether
   * a browser runs on a profile. Null when the platform cannot tell; then
   * only caches of sessions whose directory no longer exists are removed. */
  profileInUse(): Promise<((profileDirectory: string) => boolean) | null>;
  stopped(): boolean;
};

/** Startup cleanup: drop the caches of every session whose browser is not
 * running, and remove ~/.cache counterparts left by sessions that already
 * ended. Returns the session names whose caches were removed. A failure on
 * one session is reported and the sweep goes on. */
export async function sweepStoppedBrowserCaches(sweep: BrowserCacheSweep): Promise<string[]> {
  const sessionsDirectory = resolve(sweep.sessionsDirectory);
  const sessions = await sessionNames(sessionsDirectory);
  const mirrors: Array<{ mirror: string; names: string[] }> = [];
  for (const mirror of await cacheMirrorDirectories(sessionsDirectory)) {
    mirrors.push({ mirror, names: await sessionNames(mirror) });
  }
  if (sessions.length === 0 && mirrors.every((entry) => entry.names.length === 0)) return [];
  const inUse = await sweep.profileInUse().catch(() => null);
  const live = new Set(sessions);
  const running = (name: string) =>
    sweep.busy(name) || inUse === null || inUse(join(sessionsDirectory, name, "profile"));
  const removed = new Set<string>();
  for (const name of sessions) {
    if (sweep.stopped()) return [...removed];
    if (running(name)) continue;
    try {
      await discardBrowserCaches(join(sessionsDirectory, name));
      removed.add(name);
    } catch (error) {
      console.warn("browserd.cache_sweep_failed", { name, error: String(error) });
    }
  }
  for (const { mirror, names } of mirrors) {
    for (const name of names) {
      if (sweep.stopped()) return [...removed];
      if (removed.has(name)) continue;
      // A session that is still on disk keeps its counterpart while its
      // browser may be running from before this sweep; one that is gone
      // (ended before launches named their cache directory) has no browser.
      if (live.has(name) ? running(name) : sweep.busy(name)) continue;
      try {
        await rm(join(mirror, name), { recursive: true, force: true });
        removed.add(name);
      } catch (error) {
        console.warn("browserd.cache_sweep_failed", { name, error: String(error) });
      }
    }
  }
  return [...removed];
}

async function sessionNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SESSION_DIRECTORY_NAME.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
