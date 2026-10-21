import { describe, expect, test } from "bun:test";
import { getSettings, retainedImageWorkspaceQuotaBytes } from "../src";

const WORKSPACE = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const OTHER_WORKSPACE = "7a1c2e3f-5b6d-4e8f-9a0b-1c2d3e4f5a6b";

describe("retained image workspace quota settings", () => {
  test("defaults every workspace to 5 GiB", () => {
    const settings = withEnv({}, getSettings);
    expect(settings.retainedImageWorkspaceQuotaBytes).toBe(5 * 1024 * 1024 * 1024);
    expect(settings.retainedImageWorkspaceQuotaOverrides).toEqual({});
    expect(retainedImageWorkspaceQuotaBytes(settings, WORKSPACE)).toBe(5 * 1024 * 1024 * 1024);
  });

  test("a deployment default and per-workspace overrides are configurable", () => {
    const settings = withEnv(
      {
        OPENGENI_RETAINED_IMAGE_WORKSPACE_QUOTA_BYTES: "1000",
        OPENGENI_RETAINED_IMAGE_WORKSPACE_QUOTA_OVERRIDES: JSON.stringify({
          [WORKSPACE.toUpperCase()]: 50_000,
        }),
      },
      getSettings,
    );
    expect(retainedImageWorkspaceQuotaBytes(settings, WORKSPACE)).toBe(50_000);
    expect(retainedImageWorkspaceQuotaBytes(settings, WORKSPACE.toUpperCase())).toBe(50_000);
    expect(retainedImageWorkspaceQuotaBytes(settings, OTHER_WORKSPACE)).toBe(1000);
  });

  test("rejects malformed limits", () => {
    for (const env of [
      { OPENGENI_RETAINED_IMAGE_WORKSPACE_QUOTA_BYTES: "0" },
      { OPENGENI_RETAINED_IMAGE_WORKSPACE_QUOTA_OVERRIDES: "not json" },
      { OPENGENI_RETAINED_IMAGE_WORKSPACE_QUOTA_OVERRIDES: '{"not-a-uuid":1000}' },
      { OPENGENI_RETAINED_IMAGE_WORKSPACE_QUOTA_OVERRIDES: `{"${WORKSPACE}":-1}` },
      { OPENGENI_RETAINED_IMAGE_WORKSPACE_QUOTA_OVERRIDES: `[1000]` },
    ]) {
      expect(() => withEnv(env, getSettings)).toThrow();
    }
  });
});

function withEnv<T>(env: NodeJS.ProcessEnv, run: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return run();
  } finally {
    process.env = original;
  }
}
