import { describe, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import { testSettings } from "../src/settings";

describe("test settings API application pool", () => {
  test("provides the required positive integer from canonical defaults", () => {
    const canonical = getSettings({});
    const fixture = testSettings();

    expect(fixture.apiDatabasePoolMax).toBe(canonical.apiDatabasePoolMax);
    expect(Number.isSafeInteger(fixture.apiDatabasePoolMax)).toBe(true);
    expect(fixture.apiDatabasePoolMax).toBeGreaterThan(0);
  });

  test("honors an explicit capacity without changing other fixture settings or future defaults", () => {
    const canonical = getSettings({});
    const capacity = getSettings({
      OPENGENI_API_DATABASE_POOL_MAX: String(canonical.apiDatabasePoolMax + 1),
    }).apiDatabasePoolMax;
    const base = testSettings();
    const configured = testSettings({
      apiDatabasePoolMax: capacity,
      temporalTaskQueue: base.temporalTaskQueue,
    });

    expect(configured.apiDatabasePoolMax).toBe(capacity);
    expect({ ...configured, apiDatabasePoolMax: base.apiDatabasePoolMax }).toEqual(base);
    expect(testSettings().apiDatabasePoolMax).toBe(canonical.apiDatabasePoolMax);
  });

  test("does not borrow invalid ambient deployment capacity into test defaults", () => {
    expect(() => getSettings({ OPENGENI_API_DATABASE_POOL_MAX: "0" })).toThrow();
    const helper = new URL("../src/settings.ts", import.meta.url).href;
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `import { testSettings } from ${JSON.stringify(helper)}; process.stdout.write(JSON.stringify(testSettings().apiDatabasePoolMax));`,
      ],
      {
        env: { ...process.env, OPENGENI_API_DATABASE_POOL_MAX: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toBe(getSettings({}).apiDatabasePoolMax);
  });
});
