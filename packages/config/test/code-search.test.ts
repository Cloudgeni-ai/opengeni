import { describe, expect, test } from "bun:test";
import {
  codeSearchDeploymentJudge,
  codeSearchDeploymentPolicy,
  getSettings,
  usableJevApiKey,
} from "../src";

describe("Jev and code_search settings", () => {
  test("default to off with the native Jev endpoint", () => {
    const settings = withEnv({}, getSettings);
    expect(settings.codeSearchMode).toBe("off");
    expect(settings.codeSearchFunding).toBe("all");
    expect(settings.codeSearchBillingMode).toBe("usage_only");
    expect(settings.codeSearchCreditMarginBps).toBe(500);
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

  test("funding defaults to all and accepts credits_only", () => {
    const creditsOnly = withEnv({ OPENGENI_CODE_SEARCH_FUNDING: "credits_only" }, getSettings);
    expect(creditsOnly.codeSearchFunding).toBe("credits_only");
    expect(() => withEnv({ OPENGENI_CODE_SEARCH_FUNDING: "credits" }, getSettings)).toThrow();
  });

  test("billing mode and margin are validated", () => {
    const credits = withEnv(
      { OPENGENI_CODE_SEARCH_BILLING_MODE: "credits", OPENGENI_CODE_SEARCH_CREDIT_MARGIN_BPS: "0" },
      getSettings,
    );
    expect(credits.codeSearchBillingMode).toBe("credits");
    expect(credits.codeSearchCreditMarginBps).toBe(0);
    expect(() => withEnv({ OPENGENI_CODE_SEARCH_BILLING_MODE: "shadow" }, getSettings)).toThrow();
    expect(() => withEnv({ OPENGENI_CODE_SEARCH_CREDIT_MARGIN_BPS: "-1" }, getSettings)).toThrow();
    expect(() => withEnv({ OPENGENI_CODE_SEARCH_CREDIT_MARGIN_BPS: "2.5" }, getSettings)).toThrow();
  });

  test("the judge defaults to TypeSafe on the Jev key", () => {
    const settings = withEnv({ OPENGENI_JEV_API_KEY: "jev_live_example_1234567890" }, getSettings);
    expect(codeSearchDeploymentJudge(settings)).toEqual({
      provider: "typesafe",
      apiKey: "jev_live_example_1234567890",
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
    });
  });

  test("an OpenRouter or Gateway judge uses that provider's deployment key", () => {
    const openrouter = withEnv(
      {
        OPENGENI_CODE_SEARCH_MODE: "opt_in",
        OPENGENI_CODE_SEARCH_JUDGE_PROVIDER: "openrouter",
        OPENGENI_OPENROUTER_API_KEY: "sk-or-v1-example-1234567890",
      },
      getSettings,
    );
    expect(codeSearchDeploymentJudge(openrouter)).toEqual({
      provider: "openrouter",
      apiKey: "sk-or-v1-example-1234567890",
    });
    expect(codeSearchDeploymentPolicy(openrouter).available).toBe(true);
    const gateway = withEnv(
      {
        OPENGENI_CODE_SEARCH_MODE: "opt_in",
        OPENGENI_CODE_SEARCH_JUDGE_PROVIDER: "vercel_gateway",
        OPENGENI_CODE_SEARCH_JUDGE_MODEL: "typesafe-ai/jev",
        OPENGENI_JEV_API_KEY: "jev_live_example_1234567890",
      },
      getSettings,
    );
    // The Jev key does not pay for a Gateway judge.
    expect(codeSearchDeploymentJudge(gateway)).toBeUndefined();
    expect(codeSearchDeploymentPolicy(gateway).available).toBe(false);
    expect(() =>
      withEnv({ OPENGENI_CODE_SEARCH_JUDGE_PROVIDER: "anthropic" }, getSettings),
    ).toThrow();
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
