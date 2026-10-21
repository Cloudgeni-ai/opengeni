import { describe, expect, test } from "bun:test";
import {
  codeSearchDeploymentPolicy,
  decisionModelConfiguration,
  getSettings,
  usableJevApiKey,
} from "../src";

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

  test.each(["jev", "openai", "openrouter"])(
    "shared %s configuration serves both consumers",
    (provider) => {
      const settings = withEnv(
        {
          OPENGENI_CODE_SEARCH_MODE: "opt_in",
          OPENGENI_DECISION_MODEL_PROVIDER: provider,
          OPENGENI_DECISION_MODEL_ID: "configured-model",
          OPENGENI_DECISION_MODEL_API_KEY: "configured-test-key",
          OPENGENI_DECISION_MODEL_BASE_URL: "https://decisions.test/v1",
        },
        getSettings,
      );
      expect(decisionModelConfiguration(settings)).toEqual({
        provider,
        model: "configured-model",
        apiKey: "configured-test-key",
        baseUrl: "https://decisions.test/v1",
      });
      expect(codeSearchDeploymentPolicy(settings)).toEqual({
        available: true,
        workspaceDefault: "off",
      });
    },
  );

  test("partial shared configuration never borrows the legacy credential", () => {
    const settings = withEnv(
      {
        OPENGENI_CODE_SEARCH_MODE: "default_on",
        OPENGENI_JEV_API_KEY: "legacy-test-key",
        OPENGENI_DECISION_MODEL_PROVIDER: "openrouter",
        OPENGENI_DECISION_MODEL_ID: "configured-model",
      },
      getSettings,
    );
    expect(decisionModelConfiguration(settings, true)).toBeUndefined();
    expect(codeSearchDeploymentPolicy(settings).available).toBe(false);
  });

  test("legacy compatibility enables only code search, not new paid consumers", () => {
    const settings = withEnv({ OPENGENI_JEV_API_KEY: "legacy-test-key" }, getSettings);
    expect(decisionModelConfiguration(settings)).toBeUndefined();
    expect(decisionModelConfiguration(settings, true)?.provider).toBe("jev");
    expect(codeSearchDeploymentPolicy(settings).available).toBe(false);
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
