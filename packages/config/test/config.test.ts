import { describe, expect, test } from "bun:test";
import {
  collectGitIdentityEnvironment,
  collectSandboxEnvironment,
  configuredAllowedModels,
  configuredAllowedReasoningEfforts,
  getSettings,
  parseMcpServers,
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

  test("parses model image context size cap", () => {
    const original = { ...process.env };
    try {
      process.env.INFRA_AGENT_MODEL_IMAGE_MAX_BYTES = "1234";
      expect(getSettings().modelImageMaxBytes).toBe(1234);
    } finally {
      process.env = original;
    }
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

  test("parses MCP server registry JSON", () => {
    const parsed = parseMcpServers('[{"id":"docs","name":"Document Search","url":"http://127.0.0.1:8787/mcp","allowedTools":["search_documents"]}]');
    const settings = {
      ...getSettings(),
      mcpServers: parsed as ReturnType<typeof getSettings>["mcpServers"],
    };
    expect(settings.mcpServers[0]?.id).toBe("docs");
    expect(settings.mcpServers[0]?.allowedTools).toEqual(["search_documents"]);
  });

  test("rejects non-array MCP server registry JSON", () => {
    expect(() => parseMcpServers('{"id":"docs"}')).toThrow("must be a JSON array");
  });

  test("parses object storage settings and rejects incomplete credentials", () => {
    const original = { ...process.env };
    try {
      process.env.INFRA_AGENT_OBJECT_STORAGE_ENDPOINT = "http://127.0.0.1:9000";
      process.env.INFRA_AGENT_OBJECT_STORAGE_ACCESS_KEY_ID = "minioadmin";
      process.env.INFRA_AGENT_OBJECT_STORAGE_SECRET_ACCESS_KEY = "minioadmin";
      const settings = getSettings();
      expect(settings.objectStorageEndpoint).toBe("http://127.0.0.1:9000");
      expect(settings.objectStorageBucket).toBe("infra-agents-files");
      expect(settings.objectStorageForcePathStyle).toBe(true);

      delete process.env.INFRA_AGENT_OBJECT_STORAGE_SECRET_ACCESS_KEY;
      expect(() => getSettings()).toThrow("both be set or both omitted");
    } finally {
      process.env = original;
    }
  });
});
