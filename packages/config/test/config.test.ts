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

  test("registers built-in MCP profiles by default", () => {
    const settings = getSettings();
    expect(settings.mcpServers.find((server) => server.id === "infra_agents")).toMatchObject({
      name: "Infra Agents",
      url: `http://127.0.0.1:${settings.apiPort}/v1/mcp`,
    });
    expect(settings.mcpServers.find((server) => server.id === "files")).toMatchObject({
      name: "Files",
      url: `http://127.0.0.1:${settings.apiPort}/v1/mcp`,
      allowedTools: ["files_get_download_url"],
    });
    expect(settings.mcpServers.find((server) => server.id === "docs")).toMatchObject({
      name: "Document Search",
      url: `http://127.0.0.1:${settings.apiPort}/v1/mcp/docs`,
      allowedTools: ["search_documents", "fetch_document_chunk", "list_document_bases"],
    });
  });

  test("does not duplicate a custom files MCP profile", () => {
    const original = { ...process.env };
    try {
      process.env.INFRA_AGENT_MCP_SERVERS = '[{"id":"files","name":"Custom Files","url":"http://127.0.0.1:8787/mcp","allowedTools":["custom_download"]}]';
      const settings = getSettings();
      const ids = settings.mcpServers.map((server) => server.id);
      expect(ids.filter((id) => id === "files")).toHaveLength(1);
      expect(settings.mcpServers.find((server) => server.id === "files")).toMatchObject({
        name: "Custom Files",
        url: "http://127.0.0.1:8787/mcp",
        allowedTools: ["custom_download"],
      });
    } finally {
      process.env = original;
    }
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

  test("parses document indexing settings", () => {
    const original = { ...process.env };
    try {
      process.env.INFRA_AGENT_DOCUMENT_CHUNK_SIZE = "2000";
      process.env.INFRA_AGENT_DOCUMENT_CHUNK_OVERLAP = "200";
      process.env.INFRA_AGENT_DOCUMENT_EMBEDDING_PROVIDER = "deterministic";
      process.env.INFRA_AGENT_DOCUMENT_EMBEDDING_MODEL = "local-test";
      process.env.INFRA_AGENT_DOCUMENT_EMBEDDING_DIMENSIONS = "3072";
      const settings = getSettings();
      expect(settings.documentParser).toBe("liteparse");
      expect(settings.documentChunkSize).toBe(2000);
      expect(settings.documentChunkOverlap).toBe(200);
      expect(settings.documentEmbeddingProvider).toBe("deterministic");
      expect(settings.documentEmbeddingModel).toBe("local-test");
      expect(settings.documentEmbeddingDimensions).toBe(3072);
    } finally {
      process.env = original;
    }
  });

  test("rejects invalid document chunk overlap", () => {
    const original = { ...process.env };
    try {
      process.env.INFRA_AGENT_DOCUMENT_CHUNK_SIZE = "100";
      process.env.INFRA_AGENT_DOCUMENT_CHUNK_OVERLAP = "100";
      expect(() => getSettings()).toThrow("must be smaller");
    } finally {
      process.env = original;
    }
  });
});
