import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markProfileExitedCleanly, setProfileDownloadDirectory } from "../src/profile-exit-state";

async function profileWith(preferences: string | null) {
  const profile = await mkdtemp(join(tmpdir(), "browserd-exit-state-"));
  await mkdir(join(profile, "Default"));
  if (preferences !== null)
    await writeFile(join(profile, "Default", "Preferences"), preferences, { mode: 0o600 });
  return profile;
}

describe("markProfileExitedCleanly", () => {
  test("records a crashed last run as a normal exit and keeps everything else", async () => {
    const profile = await profileWith(
      JSON.stringify({
        profile: { exit_type: "Crashed", exited_cleanly: false, name: "Person" },
        session: { restore_on_startup: 1 },
      }),
    );
    try {
      expect(await markProfileExitedCleanly(profile)).toBe(true);
      const path = join(profile, "Default", "Preferences");
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        profile: { exit_type: "Normal", exited_cleanly: true, name: "Person" },
        session: { restore_on_startup: 1 },
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(join(profile, "Default"))).toEqual(["Preferences"]);
      expect(await markProfileExitedCleanly(profile)).toBe(false);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  test("leaves clean, missing and unreadable profiles untouched", async () => {
    const cases = [
      JSON.stringify({ profile: { exit_type: "Normal" } }),
      JSON.stringify({ profile: { exit_type: "SessionEnded" } }),
      JSON.stringify({ other: true }),
      "{not json",
      null,
    ];
    for (const preferences of cases) {
      const profile = await profileWith(preferences);
      try {
        expect(await markProfileExitedCleanly(profile)).toBe(false);
        if (preferences !== null)
          expect(await readFile(join(profile, "Default", "Preferences"), "utf8")).toBe(preferences);
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  });
});

describe("setProfileDownloadDirectory", () => {
  const downloads = {
    default_directory: "/managed/downloads/files",
    prompt_for_download: false,
    directory_upgrade: true,
  };

  test("makes the folder the profile's downloads folder and keeps everything else", async () => {
    const profile = await profileWith(
      JSON.stringify({
        download: { default_directory: "/elsewhere/Downloads", extensions_to_open: "" },
        profile: { name: "Person" },
      }),
    );
    try {
      await setProfileDownloadDirectory(profile, "/managed/downloads/files");
      const path = join(profile, "Default", "Preferences");
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        download: { ...downloads, extensions_to_open: "" },
        savefile: { default_directory: "/managed/downloads/files" },
        profile: { name: "Person" },
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(join(profile, "Default"))).toEqual(["Preferences"]);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  test("creates missing preferences and replaces unreadable ones Chromium would reset", async () => {
    for (const preferences of [null, "{not json", "[]"]) {
      const profile = await mkdtemp(join(tmpdir(), "browserd-downloads-"));
      if (preferences !== null) {
        await mkdir(join(profile, "Default"));
        await writeFile(join(profile, "Default", "Preferences"), preferences);
      }
      try {
        await setProfileDownloadDirectory(profile, "/managed/downloads/files");
        expect(JSON.parse(await readFile(join(profile, "Default", "Preferences"), "utf8"))).toEqual(
          { download: downloads, savefile: { default_directory: "/managed/downloads/files" } },
        );
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  });

  test("refuses preferences it cannot rewrite rather than let downloads go elsewhere", async () => {
    const profile = await mkdtemp(join(tmpdir(), "browserd-downloads-"));
    await mkdir(join(profile, "Default", "Preferences"), { recursive: true });
    try {
      await expect(
        setProfileDownloadDirectory(profile, "/managed/downloads/files"),
      ).rejects.toThrow("cannot hold the downloads folder");
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
});
