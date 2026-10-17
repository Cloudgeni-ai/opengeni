import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markProfileExitedCleanly } from "../src/profile-exit-state";

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
