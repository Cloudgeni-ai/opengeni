import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const HEADLESS_SHELL_VERSION = "150.0.7871.46";
export const HEADLESS_SHELL_ARCHIVE_URL = `https://storage.googleapis.com/chrome-for-testing-public/${HEADLESS_SHELL_VERSION}/linux64/chrome-headless-shell-linux64.zip`;
/** Recorded SHA-256 of the official Google archive; not an upstream signature. */
export const HEADLESS_SHELL_ARCHIVE_SHA256 =
  "0395e5db8d1631d5ed879d4f05fec423425537018fa1d73a58b1ade13288f447";
const BUNDLE_SHA256 = "a7e901dc975f689e34a4404c39f99183841cbe3c65916295fcf455a944a3ba27";
const PROFILE_MARKER = ".opengeni-headless-shell.json";
export type VerifiedHeadlessShell = { path: string; version: typeof HEADLESS_SHELL_VERSION };

/** Verify the executable AND its adjacent libraries/resources before selecting it. */
export async function resolvePinnedHeadlessShell(
  directory: string,
  platform = process.platform,
  architecture = process.arch,
): Promise<VerifiedHeadlessShell> {
  if (platform !== "linux" || architecture !== "x64")
    throw new Error("Pinned headless shell supports linux-x64 only");
  const root = resolve(directory);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("Headless shell bundle must be an exact directory");
  const entries: string[] = [];
  async function visit(relative: string): Promise<void> {
    for (const name of await readdir(join(root, relative))) {
      const key = relative ? `${relative}/${name}` : name;
      const path = join(root, key);
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw new Error("Headless shell bundle cannot contain symbolic links");
      if (stat.isDirectory()) {
        await visit(key);
        continue;
      }
      if (!stat.isFile()) throw new Error("Headless shell bundle contains an unsupported entry");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await handle.stat();
        if (current.dev !== stat.dev || current.ino !== stat.ino)
          throw new Error("Headless shell bundle changed during verification");
        const hash = createHash("sha256");
        for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
        entries.push(`${key}\0${hash.digest("hex")}\n`);
      } finally {
        await handle.close();
      }
    }
  }
  await visit("");
  entries.sort();
  if (createHash("sha256").update(entries.join("")).digest("hex") !== BUNDLE_SHA256)
    throw new Error("Headless shell bundle digest mismatch");
  const path = join(root, "chrome-headless-shell");
  await access(path, constants.X_OK);
  return { path, version: HEADLESS_SHELL_VERSION };
}

/** Existing/restored Chromium profiles stay on their original launcher. The marker
 * travels with a shell profile through suspend/restore; missing matching opt-in
 * fails closed instead of silently changing the executable on recovery. */
export async function selectManagedChromiumExecutable(input: {
  headed: boolean;
  restoredProfile?: boolean;
  profileDirectory: string;
  browserExecutablePath?: string;
  headlessShell?: VerifiedHeadlessShell;
}): Promise<string | undefined> {
  const marker = join(input.profileDirectory, PROFILE_MARKER);
  let recorded: string | undefined;
  try {
    recorded = await readFile(marker, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (recorded !== undefined) {
    if (
      recorded !== JSON.stringify({ version: HEADLESS_SHELL_VERSION }) ||
      input.headed ||
      !input.headlessShell
    )
      throw new Error("Headless shell profile requires its matching headless launcher");
    return input.headlessShell.path;
  }
  if (
    input.headed ||
    input.restoredProfile ||
    !input.headlessShell ||
    (await readdir(input.profileDirectory)).length > 0
  )
    return input.browserExecutablePath;
  await writeFile(marker, JSON.stringify({ version: HEADLESS_SHELL_VERSION }), {
    flag: "wx",
    mode: 0o600,
  });
  return input.headlessShell.path;
}
