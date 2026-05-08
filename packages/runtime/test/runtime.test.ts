import { describe, expect, test } from "bun:test";
import { OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE, RunRawModelStreamEvent } from "@openai/agents";
import { applyMissingManifestEntries, azurePreflightCommand, buildInfraAgent, buildManifest, deserializeSandboxSessionStateEnvelope, ensureReadableStreamFrom, normalizeSdkEvent, prepareRunInput, prefixedMcpToolName, prepareAgentTools, runAzurePreflight, sandboxCommandExitCode, sandboxRunAs } from "../src/index";
import { Manifest } from "@openai/agents/sandbox";
import { startTestMcpServer, testSettings } from "@infra-agents/testing";
import type { MCPServer } from "@openai/agents";

describe("runtime event normalization", () => {
  test("maps core SDK text deltas into session deltas", () => {
    const [event] = normalizeSdkEvent(new RunRawModelStreamEvent({
      type: "output_text_delta",
      delta: "hello",
    } as any));

    expect(event).toEqual({
      type: "agent.message.delta",
      payload: { text: "hello" },
    });
  });

  test("ignores duplicate raw Responses text delta mirror events", () => {
    const events = normalizeSdkEvent({
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "response.output_text.delta",
          delta: "hello",
        },
      },
    } as any);

    expect(events).toEqual([]);
  });

  test("maps Responses reasoning summary deltas into text-only reasoning events", () => {
    const events = normalizeSdkEvent(new RunRawModelStreamEvent({
      type: "model",
      providerData: {
        rawModelEventSource: OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
      },
        event: {
          type: "response.reasoning_summary_text.delta",
          delta: "Checking credentials",
        },
    } as any));

    expect(events).toEqual([
      { type: "agent.reasoning.delta", payload: { text: "Checking credentials" } },
    ]);
  });

  test("does not persist raw SDK reasoning items", () => {
    const events = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        type: "reasoning_item",
        rawItem: {
          type: "reasoning",
          content: [{ type: "input_text", text: "raw reasoning summary object" }],
        },
      },
    } as any);

    expect(events).toEqual([]);
  });

  test("maps tool call stream items into tool events", () => {
    const [event] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        id: "item-1",
        type: "tool_call_item",
        rawItem: {
          callId: "call-1",
          type: "shell_call",
          action: { commands: ["terraform version"] },
        },
      },
    } as any);

    expect(event?.type).toBe("agent.toolCall.created");
    expect((event?.payload as { id: string }).id).toBe("call-1");
  });

  test("uses normal Azure CLI service principal preflight", () => {
    const command = azurePreflightCommand();
    expect(command).toContain("export HOME=");
    expect(command).toContain("export AZURE_CONFIG_DIR=");
    expect(command).toContain("mkdir -p \"$AZURE_CONFIG_DIR\"");
    expect(command).toContain("command -v az");
    expect(command).toContain("az login --service-principal");
    expect(command).toContain("az account set --subscription");
    expect(command).not.toContain("infra-agent-azure-login");
  });

  test("runs Azure preflight as the sandbox agent user", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runAzurePreflight({
      execCommand: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { status: 0, output: "" };
      },
    } as any, undefined, "sandbox");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.runAs).toBe("sandbox");
    expect(calls[0]?.workdir).toBe("/workspace");
  });

  test("recognizes common sandbox command exit code shapes", () => {
    expect(sandboxCommandExitCode({ exitCode: 127 })).toBe(127);
    expect(sandboxCommandExitCode({ exit_code: 127 })).toBe(127);
    expect(sandboxCommandExitCode({ code: 127 })).toBe(127);
    expect(sandboxCommandExitCode({ status: 127 })).toBe(127);
    expect(sandboxCommandExitCode(undefined)).toBe(null);
  });

  test("provides ReadableStream.from for Modal sandbox compatibility under Bun", async () => {
    ensureReadableStreamFrom();
    const stream = (ReadableStream as any).from(["a", "b"]) as ReadableStream<string>;
    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: "a" });
    expect(await reader.read()).toEqual({ done: false, value: "b" });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test("keeps text-only first-turn input as a string", async () => {
    const prepared = await prepareRunInput(buildInfraAgent(testSettings({ sandboxBackend: "none" }), []), {
      kind: "message",
      text: "hello",
      serializedRunState: null,
    });
    expect(prepared.input).toBe("hello");
  });

  test("builds agents without MCP servers by default", () => {
    const agent = buildInfraAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(agent.mcpServers).toEqual([]);
  });

  test("sets sandbox runAs for sandbox backends only", () => {
    expect(sandboxRunAs(testSettings({ sandboxBackend: "docker" }))).toBe("sandbox");
    expect(sandboxRunAs(testSettings({ sandboxBackend: "modal" }))).toBe("sandbox");
    expect(sandboxRunAs(testSettings({ sandboxBackend: "none" }))).toBeUndefined();
    expect((buildInfraAgent(testSettings({ sandboxBackend: "docker" }), []) as any).runAs).toBe("sandbox");
    expect((buildInfraAgent(testSettings({ sandboxBackend: "none" }), []) as any).runAs).toBeUndefined();
  });

  test("includes read-only attachment guidance in agent instructions", () => {
    const agent = buildInfraAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(agent.instructions).toContain("Attached files are mounted read-only; copy them before modifying.");
  });

  test("builds native S3 mount entries for file resources", () => {
    const fileId = "00000000-0000-4000-8000-000000000010";
    const manifest = buildManifest(testSettings({
      objectStorageEndpoint: "http://127.0.0.1:9000",
      objectStorageSandboxEndpoint: "http://host.docker.internal:9000",
      objectStorageAccessKeyId: "minioadmin",
      objectStorageSecretAccessKey: "minioadmin",
    }), [{ kind: "file", fileId }]);
    const entry = manifest.entries[`files/${fileId}`] as any;
    expect(entry.type).toBe("s3_mount");
    expect(entry.bucket).toBe("infra-agents-files");
    expect(entry.prefix).toBe(`files/${fileId}/original`);
    expect(entry.endpointUrl).toBe("http://host.docker.internal:9000");
    expect(entry.s3Provider).toBe("Minio");
    expect(entry.mountStrategy).toEqual({ type: "in_container", pattern: { type: "rclone", mode: "fuse" } });
  });

  test("keeps repository resources as git repo manifest entries", () => {
    const manifest = buildManifest(testSettings(), [{
      kind: "repository",
      uri: "https://github.com/acme/app.git",
      ref: "main",
    }]);
    expect(manifest.entries["repos/acme/app"]).toMatchObject({
      type: "git_repo",
      host: "github.com",
      repo: "acme/app",
      ref: "main",
    });
  });

  test("applies only missing manifest entries to resumed sandbox sessions", async () => {
    const current = buildManifest(testSettings(), [{
      kind: "repository",
      uri: "https://github.com/acme/one.git",
      ref: "main",
    }]);
    const target = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://github.com/acme/one.git",
        ref: "main",
      },
      {
        kind: "repository",
        uri: "https://github.com/acme/two.git",
        ref: "main",
      },
    ]);
    const applied: Manifest[] = [];
    await applyMissingManifestEntries({
      state: { manifest: current },
      applyManifest: async (manifest: Manifest) => {
        applied.push(manifest);
      },
    } as any, target);
    expect(applied).toHaveLength(1);
    expect(Object.keys(applied[0]!.entries)).toEqual(["repos/acme/two"]);
  });

  test("normalizes serialized manifest state before applying missing entries", async () => {
    const current = buildManifest(testSettings(), [{
      kind: "repository",
      uri: "https://github.com/acme/one.git",
      ref: "main",
    }]);
    const target = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://github.com/acme/one.git",
        ref: "main",
      },
      {
        kind: "repository",
        uri: "https://github.com/acme/two.git",
        ref: "main",
      },
    ]);
    const applied: Manifest[] = [];
    await applyMissingManifestEntries({
      state: { manifest: JSON.parse(JSON.stringify(current)) },
      applyManifest: async (manifest: Manifest) => {
        expect(typeof manifest.mountTargetsForMaterialization).toBe("function");
        applied.push(manifest);
      },
    } as any, JSON.parse(JSON.stringify(target)));
    expect(applied).toHaveLength(1);
    expect(Object.keys(applied[0]!.entries)).toEqual(["repos/acme/two"]);
  });

  test("deserializes persisted sandbox envelopes through the sandbox client", async () => {
    const manifestRecord = JSON.parse(JSON.stringify(new Manifest({ entries: {} })));
    let received: Record<string, unknown> | null = null;
    const restored = await deserializeSandboxSessionStateEnvelope({
      backendId: "docker",
      deserializeSessionState: async (state: Record<string, unknown>) => {
        received = state;
        return {
          manifest: new Manifest(state.manifest as any),
          workspaceRootPath: "/tmp/workspace",
          workspaceReady: true,
        } as any;
      },
    } as any, {
      providerState: {
        workspaceRootPath: "/tmp/workspace",
      },
      manifest: manifestRecord,
      workspaceReady: true,
    });
    expect(received?.manifest).toEqual(manifestRecord);
    expect(typeof restored?.manifest.mountTargetsForMaterialization).toBe("function");
  });

  test("fails when resumed sandbox sessions cannot apply missing manifest entries", async () => {
    const target = buildManifest(testSettings(), [{
      kind: "repository",
      uri: "https://github.com/acme/two.git",
      ref: "main",
    }]);
    await expect(applyMissingManifestEntries({
      state: { manifest: new Manifest({ root: "/workspace" }) },
    } as any, target)).rejects.toThrow("cannot apply new manifest entries");
  });

  test("uses materializeEntry fallback for resumed sandbox sessions without applyManifest", async () => {
    const target = buildManifest(testSettings(), [{
      kind: "repository",
      uri: "https://github.com/acme/two.git",
      ref: "main",
    }]);
    const materialized: string[] = [];
    await applyMissingManifestEntries({
      state: { manifest: new Manifest({ root: "/workspace" }) },
      materializeEntry: async ({ path }: { path: string }) => {
        materialized.push(path);
      },
    } as any, target);
    expect(materialized).toEqual(["repos/acme/two"]);
  });

  test("attaches selected MCP servers to built agents", () => {
    const server = fakeMcpServer("docs");
    const agent = buildInfraAgent(testSettings({ sandboxBackend: "none" }), [], {
      mcpServers: [server],
    });
    expect(agent.mcpServers).toEqual([server]);
  });

  test("prefixes MCP tool names deterministically", () => {
    expect(prefixedMcpToolName("docs", "search_documents")).toBe("docs__search_documents");
  });

  test("connects to real Streamable HTTP MCP servers with prefixes and allowed tool filtering", async () => {
    const mcp = startTestMcpServer();
    const prepared = await prepareAgentTools(testSettings({
      mcpServers: [{
        id: "docs",
        name: "Document Search",
        url: mcp.url,
        allowedTools: ["search_documents"],
        cacheToolsList: false,
      }],
    }), [{ kind: "mcp", id: "docs" }]);
    try {
      expect(prepared.mcpServers).toHaveLength(1);
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["docs__search_documents"]);

      const result = await prepared.mcpServers[0]!.callTool("docs__search_documents", { query: "network policy" });
      expect(JSON.stringify(result)).toContain("found document for network policy");
      expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "network policy" } }]);
      await expect(prepared.mcpServers[0]!.callTool("docs__fetch_document", { id: "doc-1" })).rejects.toThrow("not allowed");
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("rejects unknown MCP tool ids during runtime preparation", async () => {
    await expect(prepareAgentTools(testSettings(), [{ kind: "mcp", id: "missing" }])).rejects.toThrow("Unknown MCP server id");
  });
});

function fakeMcpServer(name: string): MCPServer {
  return {
    name,
    cacheToolsList: false,
    async connect() {},
    async close() {},
    async listTools() {
      return [];
    },
    async callTool() {
      return [];
    },
    async invalidateToolsCache() {},
  };
}
