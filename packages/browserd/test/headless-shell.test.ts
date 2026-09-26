import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HEADLESS_SHELL_VERSION,
  resolvePinnedHeadlessShell,
  selectManagedChromiumExecutable,
} from "../src/headless-shell";

const shell = { path: "/verified/chrome-headless-shell", version: HEADLESS_SHELL_VERSION } as const;

test("headless opt-in survives recovery, but never converts an existing Chromium profile", async () => {
  const profileDirectory = await mkdtemp("/tmp/ogb-shell-profile-");
  try {
    const input = {
      headed: false,
      profileDirectory,
      browserExecutablePath: "/chromium",
      headlessShell: shell,
    };
    expect(await selectManagedChromiumExecutable(input)).toBe(shell.path);
    await writeFile(join(profileDirectory, "Local State"), "cookie state");
    expect(await selectManagedChromiumExecutable(input)).toBe(shell.path);
    await expect(
      selectManagedChromiumExecutable({
        headed: false,
        profileDirectory,
        browserExecutablePath: "/chromium",
      }),
    ).rejects.toThrow("matching headless launcher");
    await expect(selectManagedChromiumExecutable({ ...input, headed: true })).rejects.toThrow(
      "matching headless launcher",
    );
    await rm(join(profileDirectory, ".opengeni-headless-shell.json"));
    expect(await selectManagedChromiumExecutable(input)).toBe("/chromium");
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
  }
});

test("headed sessions and the default headless path retain full Chromium", async () => {
  const profileDirectory = await mkdtemp("/tmp/ogb-shell-headed-");
  try {
    expect(
      await selectManagedChromiumExecutable({
        headed: true,
        profileDirectory,
        headlessShell: shell,
        browserExecutablePath: "/chromium",
      }),
    ).toBe("/chromium");
    expect(
      await selectManagedChromiumExecutable({ headed: false, profileDirectory }),
    ).toBeUndefined();
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
  }
});

test("corrupt or unsupported bundle fails before launching", async () => {
  const directory = await mkdtemp("/tmp/ogb-shell-invalid-");
  try {
    await writeFile(join(directory, "chrome-headless-shell"), "untrusted", { mode: 0o755 });
    await expect(resolvePinnedHeadlessShell(directory, "linux", "x64")).rejects.toThrow(
      "digest mismatch",
    );
    await expect(resolvePinnedHeadlessShell(directory, "linux", "arm64")).rejects.toThrow(
      "linux-x64 only",
    );
    await symlink("chrome-headless-shell", join(directory, "lib.so"));
    await expect(resolvePinnedHeadlessShell(directory, "linux", "x64")).rejects.toThrow(
      "symbolic links",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
