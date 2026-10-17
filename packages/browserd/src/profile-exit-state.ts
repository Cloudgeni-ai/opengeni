import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
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
  const path = join(profileDirectory, "Default", "Preferences");
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isFile() || metadata.size > MAX_PREFERENCES_BYTES) return false;
  let preferences: unknown;
  try {
    preferences = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // Chromium recovers an unreadable Preferences file on its own.
    return false;
  }
  if (!isRecord(preferences) || !isRecord(preferences.profile)) return false;
  const profile = preferences.profile;
  if (profile.exit_type !== "Crashed") return false;
  profile.exit_type = "Normal";
  if (profile.exited_cleanly !== undefined) profile.exited_cleanly = true;
  const temporary = join(profileDirectory, "Default", `.Preferences.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", metadata.mode & 0o777);
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
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
