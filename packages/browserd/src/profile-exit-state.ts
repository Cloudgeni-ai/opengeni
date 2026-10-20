import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Largest Preferences file this will rewrite. Chromium's own file is tens of
 * kilobytes; anything far larger is left for Chromium to handle. */
const MAX_PREFERENCES_BYTES = 16 * 1024 * 1024;

/** Managed browsers relaunch an existing profile with --restore-last-session
 * so the person's tabs come back. Chromium skips that restore when the
 * profile's last run did not end cleanly (its Preferences record
 * profile.exit_type "Crashed" from the moment the browser starts until it
 * shuts down normally); a headed browser would offer a "Restore pages?"
 * prompt instead, which a managed browser never shows. A managed browser
 * that was killed, lost with its host or stopped by an agent restart is
 * therefore relaunched with a single blank tab.
 *
 * Before relaunching such a profile, record its last run as a normal exit so
 * Chromium restores its last session. Only the default profile's exit state
 * is changed; nothing else in the file is altered. The rewrite is atomic
 * (same directory, then rename) and keeps the file's mode. Must only be
 * called while no browser process uses the profile.
 *
 * Returns whether the exit state was changed. */
export async function markProfileExitedCleanly(profileDirectory: string): Promise<boolean> {
  const current = await readPreferences(profileDirectory);
  if (!current || !isRecord(current.preferences.profile)) return false;
  const profile = current.preferences.profile;
  if (profile.exit_type !== "Crashed") return false;
  profile.exit_type = "Normal";
  if (profile.exited_cleanly !== undefined) profile.exited_cleanly = true;
  await writePreferences(profileDirectory, current.preferences, current.mode);
  return true;
}

/** Make `downloadDirectory` the profile's downloads folder, where Chromium
 * saves every download without asking, as a Chrome configured that way
 * would. Chromium then manages its downloads itself, so its Downloads page
 * opens a finished file (a PDF in a new tab) as in any Chrome. Creates the
 * profile's Preferences when it has none, and replaces an unreadable one,
 * which Chromium would reset anyway. Throws when the folder cannot be set:
 * Chromium would otherwise save into the person's own downloads folder.
 * Must only be called while no browser process uses the profile. */
export async function setProfileDownloadDirectory(
  profileDirectory: string,
  downloadDirectory: string,
): Promise<void> {
  const current = await readPreferences(profileDirectory, { replaceUnusable: true });
  if (current === null) throw new Error("profile Preferences cannot hold the downloads folder");
  const preferences = current.preferences;
  const download = isRecord(preferences.download) ? preferences.download : {};
  const savefile = isRecord(preferences.savefile) ? preferences.savefile : {};
  if (
    download.default_directory === downloadDirectory &&
    download.prompt_for_download === false &&
    download.directory_upgrade === true &&
    savefile.default_directory === downloadDirectory
  ) {
    return;
  }
  preferences.download = {
    ...download,
    default_directory: downloadDirectory,
    prompt_for_download: false,
    directory_upgrade: true,
  };
  preferences.savefile = { ...savefile, default_directory: downloadDirectory };
  await mkdir(join(profileDirectory, "Default"), { recursive: true, mode: 0o700 });
  await writePreferences(profileDirectory, preferences, current.mode);
}

/** The default profile's parsed Preferences and file mode. A missing or
 * unreadable file (which Chromium would reset) is null, or empty
 * preferences to replace it with when `replaceUnusable`. A file that is not
 * a regular file or is oversized is always null. */
async function readPreferences(
  profileDirectory: string,
  options: { replaceUnusable?: boolean } = {},
): Promise<{ preferences: Record<string, unknown>; mode: number } | null> {
  const path = join(profileDirectory, "Default", "Preferences");
  const replacement = options.replaceUnusable ? { preferences: {}, mode: 0o600 } : null;
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return replacement;
    throw error;
  }
  if (!metadata.isFile() || metadata.size > MAX_PREFERENCES_BYTES) return null;
  let preferences: unknown;
  try {
    preferences = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // Chromium recovers an unreadable Preferences file on its own.
    return replacement;
  }
  return isRecord(preferences)
    ? { preferences, mode: metadata.mode & 0o777 }
    : replacement && { ...replacement, mode: metadata.mode & 0o777 };
}

/** Replace the default profile's Preferences atomically (same directory,
 * then rename), keeping its mode. */
async function writePreferences(
  profileDirectory: string,
  preferences: Record<string, unknown>,
  mode: number,
): Promise<void> {
  const path = join(profileDirectory, "Default", "Preferences");
  const temporary = join(profileDirectory, "Default", `.Preferences.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(JSON.stringify(preferences));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
