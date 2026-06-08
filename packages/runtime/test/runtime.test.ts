import { describe, expect, test } from "bun:test";
import { OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE, RunRawModelStreamEvent } from "@openai/agents";
import { applyMissingManifestEntries, azureCliLoginCommand, azureOpenAIDefaultQuery, buildOpenGeniAgent, buildManifest, deserializeSandboxSessionStateEnvelope, ensureReadableStreamFrom, materializeSandboxFileDownloads, repositoryCloneCommand, modelResponseUsageFromSdkEvent, normalizeSdkEvent, prepareRunInput, prefixedMcpToolName, prepareAgentTools, runAzureCliLoginHook, runRepositoryCloneHook, sandboxCommandExitCode, sandboxFileDownloadsForAgent, sandboxRunAs, withSandboxFileDownloads, withSandboxLifecycleHooks } from "../src/index";
import { Manifest } from "@openai/agents/sandbox";
import { startTestMcpServer, testSettings } from "@opengeni/testing";
import type { MCPServer } from "@openai/agents";

describe("runtime event normalization", () => {
  test("does not send legacy Azure api-version query for v1 base URLs", () => {
    const query = azureOpenAIDefaultQuery(
      { azureOpenaiApiVersion: "2025-04-01-preview" },
      "https://example.openai.azure.com/openai/v1/",
    );

    expect(query).toBeUndefined();
  });

  test("keeps Azure api-version query for deployment-style base URLs", () => {
    const query = azureOpenAIDefaultQuery(
      { azureOpenaiApiVersion: "2025-04-01-preview" },
      "https://example.openai.azure.com/openai/deployments/gpt-5.5",
    );

    expect(query).toEqual({ "api-version": "2025-04-01-preview" });
  });

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

  test("extracts model usage from streamed response completion events", () => {
    const usage = modelResponseUsageFromSdkEvent({
      type: "raw_model_stream_event",
      data: {
        type: "response_done",
        response: {
          id: "resp-1",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            inputTokensDetails: { cached_tokens: 3 },
          },
        },
      },
    } as any);

    expect(usage).toEqual({
      responseId: "resp-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokensDetails: { cached_tokens: 3 },
      },
    });
  });

  test("extracts model usage from raw Responses completion events", () => {
    const usage = modelResponseUsageFromSdkEvent(new RunRawModelStreamEvent({
      type: "model",
      providerData: {
        rawModelEventSource: OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
      },
      event: {
        type: "response.completed",
        response: {
          id: "resp-2",
          usage: {
            input_tokens: 20,
            output_tokens: 8,
            total_tokens: 28,
            input_tokens_details: { cached_tokens: 4 },
          },
        },
      },
    } as any));

    expect(usage).toEqual({
      responseId: "resp-2",
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
        inputTokensDetails: { cached_tokens: 4 },
      },
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

  test("uses normal Azure CLI service principal login hook", () => {
    const command = azureCliLoginCommand();
    expect(command).toContain("export HOME=");
    expect(command).toContain("mkdir -p \"$HOME/.azure\"");
    expect(command).toContain("command -v az");
    expect(command).toContain("az login --service-principal");
    expect(command).toContain("az account set --subscription");
    expect(command).not.toContain("opengeni-azure-login");
    expect(command).not.toContain("AZURE_CONFIG_DIR");
  });

  test("runs Azure CLI login hook as the sandbox agent user", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runAzureCliLoginHook({
      execCommand: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { status: 0, output: "" };
      },
    } as any, { environment: {}, runAs: "sandbox" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.runAs).toBe("sandbox");
    expect(calls[0]?.workdir).toBe("/workspace");
  });

  test("emits lifecycle hook failure events", async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    await expect(runAzureCliLoginHook({
      execCommand: async () => ({ status: 1, output: "login failed" }),
    } as any, {
      environment: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
    })).rejects.toThrow("login failed");
    expect(events.map((event) => event.type)).toEqual(["sandbox.operation.started", "sandbox.operation.failed"]);
  });

  test("runs sandbox lifecycle hooks once per session object", async () => {
    const session = {};
    let runs = 0;
    const client = withSandboxLifecycleHooks({
      backendId: "test",
      create: async () => session,
      resume: async () => session,
    } as any, [{
      id: "test-hook",
      phase: "beforeAgentStart",
      run: async () => {
        runs += 1;
      },
    }], { environment: {} });

    await (client.create as any)();
    await client.resume!({} as any);

    expect(runs).toBe(1);
  });

  test("retries sandbox lifecycle hooks after a failed attempt on the same session object", async () => {
    const session = {};
    let runs = 0;
    const client = withSandboxLifecycleHooks({
      backendId: "test",
      create: async () => session,
      resume: async () => session,
    } as any, [{
      id: "test-hook",
      phase: "beforeAgentStart",
      run: async () => {
        runs += 1;
        if (runs === 1) {
          throw new Error("hook failed");
        }
      },
    }], { environment: {} });

    await expect((client.create as any)()).rejects.toThrow("hook failed");
    await expect(client.resume!({} as any)).resolves.toBe(session);

    expect(runs).toBe(2);
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
    const prepared = await prepareRunInput(buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []), {
      kind: "message",
      text: "hello",
      serializedRunState: null,
    });
    expect(prepared.input).toBe("hello");
  });

  test("builds agents without MCP servers by default", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(agent.mcpServers).toEqual([]);
  });

  test("sets sandbox runAs only for backends that support manifest users", () => {
    expect(sandboxRunAs(testSettings({ sandboxBackend: "docker" }))).toBe("sandbox");
    expect(sandboxRunAs(testSettings({ sandboxBackend: "modal" }))).toBeUndefined();
    expect(sandboxRunAs(testSettings({ sandboxBackend: "none" }))).toBeUndefined();
    expect((buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), []) as any).runAs).toBe("sandbox");
    expect((buildOpenGeniAgent(testSettings({ sandboxBackend: "modal" }), []) as any).runAs).toBeUndefined();
    expect((buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []) as any).runAs).toBeUndefined();
  });

  test("includes read-only attachment guidance in agent instructions", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
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
    expect(entry.bucket).toBe("opengeni-files");
    expect(entry.prefix).toBe(`files/${fileId}/original`);
    expect(entry.endpointUrl).toBe("http://host.docker.internal:9000");
    expect(entry.s3Provider).toBe("Minio");
    expect(entry.mountStrategy).toEqual({ type: "in_container", pattern: { type: "rclone", mode: "fuse" } });
  });

  test("uses Modal cloud bucket strategy for Modal S3-compatible file resources", () => {
    const fileId = "00000000-0000-4000-8000-000000000011";
    const manifest = buildManifest(testSettings({
      sandboxBackend: "modal",
      objectStorageEndpoint: "https://s3.example.com",
      objectStorageAccessKeyId: "access-key",
      objectStorageSecretAccessKey: "secret-key",
    }), [{ kind: "file", fileId }]);
    const entry = manifest.entries[`files/${fileId}`] as any;
    expect(entry.type).toBe("s3_mount");
    expect(entry.mountStrategy).toMatchObject({ type: "modal_cloud_bucket" });
  });

  test("builds native Azure Blob mount entries for file resources", () => {
    const fileId = "00000000-0000-4000-8000-000000000020";
    const manifest = buildManifest(testSettings({
      objectStorageBackend: "azure-blob",
      objectStorageAzureConnectionString: "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=secret;BlobEndpoint=https://acct.blob.core.windows.net/",
    }), [{ kind: "file", fileId }]);
    const entry = manifest.entries[`files/${fileId}`] as any;
    expect(entry.type).toBe("azure_blob_mount");
    expect(entry.container).toBe("opengeni-files");
    expect(entry.prefix).toBe(`files/${fileId}/original`);
    expect(entry.accountName).toBe("acct");
    expect(entry.accountKey).toBe("secret");
    expect(entry.endpointUrl).toBeUndefined();
    expect(entry.mountStrategy).toEqual({ type: "in_container", pattern: { type: "rclone", mode: "fuse" } });
  });

  test("keeps custom Azure Blob mount endpoints for non-standard storage hosts", () => {
    const fileId = "00000000-0000-4000-8000-000000000022";
    const manifest = buildManifest(testSettings({
      objectStorageBackend: "azure-blob",
      objectStorageAzureConnectionString: "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=secret;BlobEndpoint=https://custom.blob.example.test/",
    }), [{ kind: "file", fileId }]);
    const entry = manifest.entries[`files/${fileId}`] as any;
    expect(entry.type).toBe("azure_blob_mount");
    expect(entry.endpointUrl).toBe("https://custom.blob.example.test");
  });

  test("requires signed download materialization for Modal Azure Blob file resources", () => {
    const fileId = "00000000-0000-4000-8000-000000000021";
    expect(() => buildManifest(testSettings({
      sandboxBackend: "modal",
      objectStorageBackend: "azure-blob",
      objectStorageAzureConnectionString: "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=secret;BlobEndpoint=https://acct.blob.core.windows.net/",
    }), [{ kind: "file", fileId }])).toThrow("Modal sandbox Azure Blob file resources require pre-signed download materialization");
  });

  test("uses inline manifest files for Modal Azure Blob file materialization when content is provided", () => {
    const fileId = "00000000-0000-4000-8000-000000000023";
    const settings = testSettings({
      sandboxBackend: "modal",
      objectStorageBackend: "azure-blob",
      objectStorageAzureConnectionString: "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=secret;BlobEndpoint=https://acct.blob.core.windows.net/",
    });
    const downloads = [{
      fileId,
      mountPath: `files/${fileId}`,
      filename: "source.txt",
      content: new TextEncoder().encode("hello"),
      sizeBytes: 12,
    }];
    const manifest = buildManifest(settings, [{ kind: "file", fileId }], undefined, downloads);
    const entry = manifest.entries[`files/${fileId}`] as any;
    const agent = buildOpenGeniAgent(settings, [{ kind: "file", fileId }], { fileResourceDownloads: downloads });

    expect(entry.type).toBe("dir");
    expect(entry.children["source.txt"].type).toBe("file");
    expect(new TextDecoder().decode(entry.children["source.txt"].content)).toBe("hello");
    expect(sandboxFileDownloadsForAgent(agent)).toEqual([]);
    expect((agent as any).defaultManifest.entries[`files/${fileId}`].type).toBe("dir");
  });

  test("downloads signed file resources before sandbox use without emitting URLs in events", async () => {
    const commands: string[] = [];
    const events: string[] = [];
    await materializeSandboxFileDownloads({
      state: { manifest: new Manifest({ root: "/workspace" }) },
      exec: async ({ cmd }: { cmd: string }) => {
        commands.push(cmd);
        return { output: "", stdout: "", stderr: "", wallTimeSeconds: 0, exitCode: 0 };
      },
    } as any, [{
      fileId: "file-1",
      mountPath: "files/file-1",
      filename: "input.txt",
      url: "https://storage.example/input.txt?sig=secret",
      sizeBytes: 5,
    }], {
      onRuntimeEvent: (event) => {
        events.push(JSON.stringify(event));
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("curl --fail");
    expect(commands[0]).toContain("chmod a-w");
    expect(commands[0]).toContain("https://storage.example/input.txt?sig=secret");
    expect(events.join("\n")).not.toContain("sig=secret");
    expect(events.join("\n")).toContain("file-resource-download");
  });

  test("wraps sandbox clients with signed file downloads on create and resume", async () => {
    const sessions: any[] = [];
    const baseClient = {
      backendId: "modal",
      create: async () => {
        const session = {
          state: { manifest: new Manifest({ root: "/workspace" }) },
          execCommand: async () => "Chunk ID: abc123\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\n",
        };
        sessions.push(session);
        return session;
      },
      resume: async (state: any) => {
        const session = {
          state,
          execCommand: async () => "Chunk ID: abc123\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\n",
        };
        sessions.push(session);
        return session;
      },
    };
    const client = withSandboxFileDownloads(baseClient as any, [{
      fileId: "file-1",
      mountPath: "files/file-1",
      filename: "input.txt",
      url: "https://storage.example/input.txt?sig=secret",
    }]);

    await client.create!();
    await client.resume!({ manifest: new Manifest({ root: "/workspace" }) } as any);

    expect(sessions).toHaveLength(2);
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

  test("keeps GitHub App repository resources out of SDK git repo materialization", () => {
    const manifest = buildManifest(testSettings(), [{
      kind: "repository",
      uri: "https://github.com/acme/private.git",
      ref: "main",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    }]);
    expect(manifest.entries["repos/acme/private"]).toMatchObject({ type: "dir" });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("git_repo");
    expect(serialized).not.toContain("githubInstallationId");
    expect(serialized).not.toContain("githubRepositoryId");
    expect(serialized).not.toContain("x-access-token");
  });

  test("keeps Modal repository resources out of SDK git repo materialization", () => {
    const manifest = buildManifest(testSettings({ sandboxBackend: "modal" }), [{
      kind: "repository",
      uri: "https://github.com/acme/private.git",
      ref: "main",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    }]);

    expect(manifest.entries["repos/acme/private"]).toMatchObject({ type: "dir" });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("git_repo");
    expect(serialized).not.toContain("githubInstallationId");
    expect(serialized).not.toContain("githubRepositoryId");
    expect(serialized).not.toContain("x-access-token");
  });

  test("clones repository resources inside the sandbox without embedding credentials", () => {
    const command = repositoryCloneCommand([{
      kind: "repository",
      uri: "https://github.com/acme/private.git",
      ref: "main",
      subpath: "packages/api",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    }]);

    expect(command).toContain("git -C \"$tmp\" fetch --depth 1 --no-tags --filter=blob:none origin \"$ref\"");
    expect(command).toContain("ensure_git");
    expect(command).toContain("apt-get install -y --no-install-recommends ca-certificates git");
    expect(command).toContain("clone_repository '/workspace/repos/acme/private' 'https://github.com/acme/private.git' 'main' 'packages/api'");
    expect(command).not.toContain("githubInstallationId");
    expect(command).not.toContain("githubRepositoryId");
    expect(command).not.toContain("x-access-token");
    expect(command).not.toContain("GH_TOKEN=");
  });

  test("runs repository clone hook as a sandbox lifecycle hook", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    await runRepositoryCloneHook({
      execCommand: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { status: 0, output: "" };
      },
    } as any, [{
      kind: "repository",
      uri: "https://github.com/acme/private.git",
      ref: "main",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    }], {
      environment: { GH_TOKEN: "secret-token" },
      runAs: "sandbox",
      onRuntimeEvent: (event) => {
        events.push(event.type);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.runAs).toBe("sandbox");
    expect(calls[0]?.workdir).toBe("/workspace");
    expect(String(calls[0]?.cmd)).toContain("git init");
    expect(String(calls[0]?.cmd)).not.toContain("secret-token");
    expect(events).toEqual(["sandbox.operation.started", "sandbox.operation.completed"]);
  });

  test("keeps repository subpaths as git repo manifest subpaths", () => {
    const manifest = buildManifest(testSettings(), [{
      kind: "repository",
      uri: "https://github.com/acme/private.git",
      ref: "main",
      mountPath: "repos/acme/private/README.md",
      subpath: "README.md",
    }]);
    expect(manifest.entries["repos/acme/private/README.md"]).toMatchObject({
      type: "git_repo",
      host: "github.com",
      repo: "acme/private",
      ref: "main",
      subpath: "README.md",
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

  test("refreshes manifest environment on resumed sandbox sessions", async () => {
    const current = new Manifest({
      root: "/workspace",
      entries: {
        "repos/acme/one": { type: "git_repo", host: "github.com", repo: "acme/one", ref: "main" },
      },
      environment: { GH_TOKEN: "old-token" },
    });
    const target = new Manifest({
      root: "/workspace",
      entries: {
        "repos/acme/one": { type: "git_repo", host: "github.com", repo: "acme/one", ref: "main" },
      },
      environment: { GH_TOKEN: "new-token" },
    });
    const applied: Manifest[] = [];
    const session = {
      state: { manifest: current },
      applyManifest: async (manifest: Manifest) => {
        applied.push(manifest);
      },
    };
    await applyMissingManifestEntries(session as any, target);
    expect(applied).toHaveLength(1);
    expect(Object.keys(applied[0]!.entries)).toEqual([]);
    expect(JSON.parse(JSON.stringify((session.state.manifest as Manifest).environment))).toMatchObject({
      GH_TOKEN: { value: "new-token" },
    });
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
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      mcpServers: [server],
    });
    expect(agent.mcpServers).toEqual([server]);
  });

  test("prefixes MCP tool names deterministically", () => {
    expect(prefixedMcpToolName("docs", "search_documents")).toBe("docs__search_documents");
    expect(prefixedMcpToolName("files", "files_get_download_url")).toBe("files__files_get_download_url");
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

  test("sends the shared access key to first-party MCP servers", async () => {
    const accessKey = "local-mcp-access-key";
    const mcp = startTestMcpServer({ requiredHeaders: { "x-opengeni-access-key": accessKey } });
    const prepared = await prepareAgentTools(testSettings({
      authRequired: true,
      accessKey,
      opengeniMcpUrl: mcp.url,
      mcpServers: [{
        id: "opengeni",
        name: "OpenGeni",
        url: mcp.url,
        allowedTools: ["search_documents"],
        cacheToolsList: false,
      }],
    }), [{ kind: "mcp", id: "opengeni" }]);
    try {
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["opengeni__search_documents"]);
      const result = await prepared.mcpServers[0]!.callTool("opengeni__search_documents", { query: "auth" });
      expect(JSON.stringify(result)).toContain("found document for auth");
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
