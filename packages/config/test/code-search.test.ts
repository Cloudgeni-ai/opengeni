import { describe, expect, test } from "bun:test";
import { codeSearchDeploymentPolicy, getSettings, usableJevApiKey } from "../src";

describe("Jev and code_search settings", () => {
  test("default to off with the native Jev endpoint", () => {
    const settings = withEnv({}, getSettings);
    expect(settings.codeSearchMode).toBe("off");
    expect(settings.jevApiKey).toBeUndefined();
    expect(settings.jevBaseUrl).toBe("https://api.typesafe.ai");
    expect(settings.jevModel).toBe("jev-latest");
    expect(settings.jevRequestTimeoutMs).toBe(10_000);
    expect(codeSearchDeploymentPolicy(settings)).toEqual({
      available: false,
      workspaceDefault: "off",
    });
  });

  test("a mode without a usable key offers nothing", () => {
    const missing = withEnv({ OPENGENI_CODE_SEARCH_MODE: "default_on" }, getSettings);
    expect(codeSearchDeploymentPolicy(missing).available).toBe(false);
    const placeholder = withEnv(
      { OPENGENI_CODE_SEARCH_MODE: "default_on", OPENGENI_JEV_API_KEY: "your-key" },
      getSettings,
    );
    expect(usableJevApiKey(placeholder)).toBeUndefined();
    expect(codeSearchDeploymentPolicy(placeholder).available).toBe(false);
  });

  test("opt_in offers the tool without enabling it by default", () => {
    const settings = withEnv(
      { OPENGENI_CODE_SEARCH_MODE: "opt_in", OPENGENI_JEV_API_KEY: "jev_live_example_1234567890" },
      getSettings,
    );
    expect(codeSearchDeploymentPolicy(settings)).toEqual({
      available: true,
      workspaceDefault: "off",
    });
  });

  test("default_on and experiment set the default for workspaces without a setting", () => {
    const key = { OPENGENI_JEV_API_KEY: "jev_live_example_1234567890" };
    const on = withEnv({ ...key, OPENGENI_CODE_SEARCH_MODE: "default_on" }, getSettings);
    expect(codeSearchDeploymentPolicy(on)).toEqual({ available: true, workspaceDefault: "on" });
    const experiment = withEnv({ ...key, OPENGENI_CODE_SEARCH_MODE: "experiment" }, getSettings);
    expect(codeSearchDeploymentPolicy(experiment)).toEqual({
      available: true,
      workspaceDefault: "split",
    });
  });

  test("rejects an unknown mode", () => {
    expect(() => withEnv({ OPENGENI_CODE_SEARCH_MODE: "sometimes" }, getSettings)).toThrow();
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
