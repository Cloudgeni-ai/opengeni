import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  HEADLESS_SHELL_ARCHIVE_SHA256,
  HEADLESS_SHELL_ARCHIVE_URL,
  resolvePinnedHeadlessShell,
} from "../src/headless-shell";

// Explicit operator opt-in. Never runs during native-agent upgrades or startup.
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("Headless shell supports linux-x64 only");
if (!process.argv[2])
  throw new Error(
    "Usage: bun packages/browserd/scripts/install-headless-shell.ts /absolute/new/bundle-directory",
  );
const destination = resolve(process.argv[2]);
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(join(dirname(destination), ".headless-shell-"));
try {
  const response = await fetch(HEADLESS_SHELL_ARCHIVE_URL, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Headless shell download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== HEADLESS_SHELL_ARCHIVE_SHA256)
    throw new Error("Headless shell archive digest mismatch");
  const archive = join(temporary, "shell.zip");
  await writeFile(archive, bytes, { mode: 0o600 });
  const extraction = Bun.spawn(["unzip", "-q", archive, "-d", temporary], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await extraction.exited) !== 0) throw new Error("Headless shell extraction failed");
  const bundle = join(temporary, "chrome-headless-shell-linux64");
  await chmod(bundle, 0o700);
  await resolvePinnedHeadlessShell(bundle);
  // mkdir refuses an existing destination, including an existing installation.
  await mkdir(destination, { mode: 0o700 });
  try {
    await rename(bundle, join(destination, "bundle"));
  } catch (error) {
    await rm(destination, { recursive: true });
    throw error;
  }
  console.log(
    `Verified headless shell installed. Set OPENGENI_BROWSERD_HEADLESS_SHELL_DIRECTORY=${join(destination, "bundle")}`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
