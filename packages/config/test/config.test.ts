import { describe, expect, test } from "bun:test";
import {
  collectGitIdentityEnvironment,
  collectSandboxEnvironment,
  configuredAllowedModels,
  configuredAllowedReasoningEfforts,
  getSettings,
  sandboxEnvironmentVariableNames,
} from "../src";

describe("sandbox environment profiles", () => {
  test("collects azure and github profile values plus extras", () => {
    const settings = getSettings();
    const env = {
      ARM_CLIENT_ID: "arm-client",
      GITHUB_TOKEN: "github-token",
      CUSTOM_PROVIDER_TOKEN: "custom",
    };
    const names = sandboxEnvironmentVariableNames({
      ...settings,
      sandboxEnvProfiles: "azure,github",
      sandboxEnvExtraVars: "CUSTOM_PROVIDER_TOKEN",
      sandboxEnvVars: undefined,
    });
    expect(names).toContain("ARM_CLIENT_ID");
    expect(names).toContain("GITHUB_TOKEN");
    expect(names).toContain("GIT_AUTHOR_NAME");
    expect(names).toContain("CUSTOM_PROVIDER_TOKEN");
    expect(collectSandboxEnvironment({
      ...settings,
      sandboxEnvProfiles: "azure,github",
      sandboxEnvExtraVars: "CUSTOM_PROVIDER_TOKEN",
      sandboxEnvVars: undefined,
    }, env)).toEqual({
      ARM_CLIENT_ID: "arm-client",
      GITHUB_TOKEN: "github-token",
      CUSTOM_PROVIDER_TOKEN: "custom",
    });
  });

  test("rejects combining none with other profiles", () => {
    const settings = getSettings();
    expect(() => sandboxEnvironmentVariableNames({
      ...settings,
      sandboxEnvProfiles: "none,github",
    })).toThrow("cannot combine none");
  });

  test("returns client model and reasoning options with current defaults included", () => {
    const settings = {
      ...getSettings(),
      openaiModel: "custom-model",
      openaiAllowedModels: "gpt-5.5",
      openaiReasoningEffort: "xhigh" as const,
      openaiAllowedReasoningEfforts: "low,medium,high",
    };
    expect(configuredAllowedModels(settings)).toEqual(["custom-model", "gpt-5.5"]);
    expect(configuredAllowedReasoningEfforts(settings)).toEqual(["xhigh", "low", "medium", "high"]);
  });

  test("collects git identity settings for sandbox pass-through", () => {
    expect(collectGitIdentityEnvironment({
      ...getSettings(),
      gitAuthorName: "Infra Agent",
      gitAuthorEmail: "infra@example.com",
      gitCommitterName: undefined,
      gitCommitterEmail: undefined,
    })).toEqual({
      GIT_AUTHOR_NAME: "Infra Agent",
      GIT_AUTHOR_EMAIL: "infra@example.com",
      GIT_COMMITTER_NAME: "Infra Agent",
      GIT_COMMITTER_EMAIL: "infra@example.com",
    });
  });
});
