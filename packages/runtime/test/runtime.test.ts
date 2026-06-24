import { describe, expect, test } from "bun:test";
import { OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE, RunRawModelStreamEvent, getAllMcpTools, invalidateServerToolsCache } from "@openai/agents";
import { AGENT_INSTRUCTIONS_CORE_PLACEHOLDER, DEFAULT_AGENT_INSTRUCTIONS, getSettings } from "@opengeni/config";
import { CLEARED_RUN_STATE_BLOB } from "@opengeni/contracts";
import { applyMissingManifestEntries, azureCliLoginCommand, azureOpenAIDefaultQuery, buildOpenGeniAgent, buildManifest, composeAgentInstructions, coreInstructions, lazySkillSourceWithPackSkills, deserializeSandboxSessionStateEnvelope, ensureReadableStreamFrom, materializeSandboxFileDownloads, repositoryCloneCommand, modelResponseUsageFromSdkEvent, normalizeSdkEvent, prepareRunInput, stripProviderItemIdsFilter, callModelInputFilterForSettings, prefixedMcpToolName, prepareAgentTools, runAzureCliLoginHook, runRepositoryCloneHook, sandboxCommandExitCode, sandboxFileDownloadsForAgent, sandboxRunAs, withSandboxFileDownloads, withSandboxLifecycleHooks } from "../src/index";
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

  test("treats the cleared run-state sentinel as a fresh start (run_state mode /clear)", async () => {
    // Regression (adversarial review): after /clear, in run_state history mode
    // the message path reads the cleared sentinel blob (not a real serialized
    // run state — it has no $schemaVersion). RunState.fromString would throw
    // "Run state is missing schema version" and break the next turn. The reader
    // must recognize the sentinel and start clean instead, returning the bare
    // text exactly as a null state would.
    const prepared = await prepareRunInput(buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []), {
      kind: "message",
      text: "first message after clear",
      serializedRunState: CLEARED_RUN_STATE_BLOB,
    });
    expect(prepared.input).toBe("first message after clear");
    // And critically it carries no resurrected sandbox-resume descriptor.
    expect(prepared.serializedRunStateForSandbox).toBeUndefined();
  });

  test("refuses an approval resume against a cleared sentinel with an honest error", async () => {
    // The API refuses /clear in requires_action, so this is a defensive guard:
    // if the approval path ever sees the cleared sentinel it must fail with a
    // clear message, never the cryptic SDK "missing schema version" throw.
    await expect(
      prepareRunInput(buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []), {
        kind: "approval",
        serializedRunState: CLEARED_RUN_STATE_BLOB,
        approvalId: "appr_1",
        decision: "approve",
      }),
    ).rejects.toThrow(/context was cleared/i);
  });

  test("sanitizes an orphaned tool output out of replayed items-mode history", async () => {
    // A session whose stored history carries an orphaned function_call_result
    // (its function_call lost to a write-path desync) must still produce a
    // valid model input instead of one the Responses API 400s on. The read
    // path sanitizes the in-memory copy; the orphan never reaches the model.
    const orphan = { type: "function_call_result", callId: "call_orphan", output: { type: "text", text: "stale" } };
    const validCall = { type: "function_call", callId: "call_ok", name: "tool", arguments: "{}" };
    const validResult = { type: "function_call_result", callId: "call_ok", output: { type: "text", text: "ok" } };
    const prepared = await prepareRunInput(buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []), {
      kind: "message",
      text: "continue",
      historyItems: [
        { type: "message", role: "user", content: "earlier" } as any,
        orphan as any,
        validCall as any,
        validResult as any,
      ],
    });
    const input = prepared.input as Array<Record<string, unknown>>;
    expect(Array.isArray(input)).toBe(true);
    // The orphan is gone; the valid pair and the new user turn remain in order.
    expect(input.filter((item) => item.type === "function_call_result")).toEqual([validResult]);
    expect(input.some((item) => item.type === "function_call_result" && item.callId === "call_orphan")).toBe(false);
    expect(input[input.length - 1]).toEqual({ type: "message", role: "user", content: "continue" });
  });

  test("read-path budget guard trims an over-budget items-mode input before it is sent", async () => {
    // Even after the orphan sanitizer, an assembled input can exceed the model
    // window (pre-turn compaction is best-effort and can no-op). With a budget
    // supplied, the guard drops the oldest turn at a clean boundary so the
    // request that reaches the model fits — the over-budget input is never sent.
    const huge = "x".repeat(4_000_000); // ~1M token estimate, over a small test budget
    const prepared = await prepareRunInput(
      buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []),
      {
        kind: "message",
        text: "continue",
        historyItems: [
          { type: "message", role: "user", content: "old turn" } as any,
          { type: "message", role: "assistant", content: huge } as any,
          { type: "message", role: "user", content: "recent turn" } as any,
          { type: "message", role: "assistant", content: "kept" } as any,
        ],
      },
      { inputBudgetTokens: 200_000 },
    );
    const input = prepared.input as Array<Record<string, unknown>>;
    expect(Array.isArray(input)).toBe(true);
    // The bloated old turn was dropped; the recent turn and the new user message
    // survive, in order.
    expect(input.some((item) => item.content === huge)).toBe(false);
    expect(input.some((item) => item.content === "recent turn")).toBe(true);
    expect(input[input.length - 1]).toEqual({ type: "message", role: "user", content: "continue" });
  });

  test("read-path budget guard is OFF when no budget is supplied (no behaviour change for non-opted callers)", async () => {
    const huge = "x".repeat(4_000_000);
    const prepared = await prepareRunInput(
      buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []),
      {
        kind: "message",
        text: "continue",
        historyItems: [
          { type: "message", role: "user", content: "old turn" } as any,
          { type: "message", role: "assistant", content: huge } as any,
        ],
      },
      // no inputBudgetTokens -> guard disabled, history passes through untrimmed.
    );
    const input = prepared.input as Array<Record<string, unknown>>;
    expect(input.some((item) => item.content === huge)).toBe(true);
  });

  test("builds agents without MCP servers by default", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(agent.mcpServers).toEqual([]);
  });

  test("does not override the sandbox provider's default execution user", () => {
    // The sandbox provider is responsible for choosing a user that can write to
    // its workspace. Supplying a synthetic runAs user can break normal writes.
    expect(sandboxRunAs(testSettings({ sandboxBackend: "docker" }))).toBeUndefined();
    expect(sandboxRunAs(testSettings({ sandboxBackend: "local" }))).toBeUndefined();
    expect(sandboxRunAs(testSettings({ sandboxBackend: "modal" }))).toBeUndefined();
    expect(sandboxRunAs(testSettings({ sandboxBackend: "none" }))).toBeUndefined();
    expect((buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), []) as any).runAs).toBeUndefined();
    expect((buildOpenGeniAgent(testSettings({ sandboxBackend: "local" }), []) as any).runAs).toBeUndefined();
    expect((buildOpenGeniAgent(testSettings({ sandboxBackend: "modal" }), []) as any).runAs).toBeUndefined();
    expect((buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []) as any).runAs).toBeUndefined();
  });

  test("includes read-only attachment guidance in agent instructions", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(agent.instructions).toContain("Attached files are mounted read-only; copy them before modifying.");
  });

  test("surfaces attached workspace environment metadata in agent instructions", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      workspaceEnvironment: {
        name: "azure-prod",
        description: "Clone the journal repo over SSH with JOURNAL_DEPLOY_KEY.",
        variableNames: ["JOURNAL_DEPLOY_KEY", "ARM_CLIENT_ID"],
      },
    });
    expect(agent.instructions).toContain('A workspace environment named "azure-prod" is attached to this session');
    expect(agent.instructions).toContain("Exported environment variables: ARM_CLIENT_ID, JOURNAL_DEPLOY_KEY.");
    expect(agent.instructions).toContain("Environment notes from the operator: Clone the journal repo over SSH with JOURNAL_DEPLOY_KEY.");
  });

  test("omits workspace environment instructions when no environment is attached or metadata is empty", () => {
    const detached = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(detached.instructions).not.toContain("A workspace environment named");

    const minimal = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      workspaceEnvironment: { name: "bare", description: "  ", variableNames: [] },
    });
    expect(minimal.instructions).toContain('A workspace environment named "bare" is attached to this session');
    expect(minimal.instructions).not.toContain("Exported environment variables:");
    expect(minimal.instructions).not.toContain("Environment notes from the operator:");
  });

  // THE GATE. The exact preamble buildOpenGeniAgent produced before the
  // white-label split: the historical hardcoded `instructions` array from
  // origin/main (packages/runtime/src/index.ts), with no workspace environment,
  // joined by " ". Captured verbatim; the composed default MUST equal it
  // byte-for-byte so the white-label slice changes nothing on the default path.
  const HISTORICAL_DEFAULT_INSTRUCTIONS = [
    "You are an OpenGeni workspace agent.",
    "Follow the user's task and any enabled pack or skill instructions for the current role.",
    "Work inside the sandbox workspace and use filesystem and shell tools when useful.",
    "Repository resources are mounted under repos/<owner>/<repo>.",
    "File resources are mounted under files/<file-id>/ unless the session specifies another mount path.",
    "Attached files are mounted read-only; copy them before modifying.",
    "Bundled skills are under .agents/ and can include infrastructure, marketing, or other role-specific guidance.",
    "Use Checkov, Terraform, Azure CLI, GitHub CLI, and repository tools when relevant.",
    "When the Azure sandbox preparation profile is enabled and service-principal variables are present, the sandbox is pre-authenticated with normal Azure CLI before work starts.",
    "Treat code-changing work as GitOps work: create a focused branch/commit/PR when GitHub credentials are available; otherwise report exact commands and blockers.",
    "Return concise, factual summaries with files changed, commands run, and remaining blockers.",
    "If the session has a goal, you own it: keep working until you call opengeni__goal_complete with concrete evidence or opengeni__goal_pause with a rationale; revise it with opengeni__goal_update; create one with opengeni__goal_set when given a long-running objective.",
  ].join(" ");

  test("default template composes byte-identically to the historical preamble (no override, no environment)", () => {
    // Direct composition: default template + empty CORE-with-no-env.
    expect(composeAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS)).toBe(HISTORICAL_DEFAULT_INSTRUCTIONS);
    // End-to-end through the agent builder with the default settings template.
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(agent.instructions).toBe(HISTORICAL_DEFAULT_INSTRUCTIONS);
  });

  test("default template with an attached environment appends the env block exactly as before", () => {
    const env = {
      name: "azure-prod",
      description: "Clone the journal repo over SSH with JOURNAL_DEPLOY_KEY.",
      variableNames: ["JOURNAL_DEPLOY_KEY", "ARM_CLIENT_ID"],
    };
    const expected = [
      HISTORICAL_DEFAULT_INSTRUCTIONS,
      'A workspace environment named "azure-prod" is attached to this session; its variables are exported in the sandbox shell environment.',
      "Exported environment variables: ARM_CLIENT_ID, JOURNAL_DEPLOY_KEY.",
      "Environment notes from the operator: Clone the journal repo over SSH with JOURNAL_DEPLOY_KEY.",
    ].join(" ");
    expect(composeAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS, env)).toBe(expected);
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], { workspaceEnvironment: env });
    expect(agent.instructions).toBe(expected);
  });

  test("a white-label persona override is substituted at {{core}} but keeps the non-bypassable CORE", () => {
    const template = `You are ACME's deployment co-pilot. ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER} Stay on brand.`;
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], { instructionsTemplate: template });
    expect(agent.instructions).toContain("You are ACME's deployment co-pilot.");
    expect(agent.instructions).not.toContain("You are an OpenGeni workspace agent.");
    // CORE (the goal-loop ownership line naming opengeni__goal_*) survives.
    expect(agent.instructions).toContain("you call opengeni__goal_complete with concrete evidence");
    expect(agent.instructions).toBe(`You are ACME's deployment co-pilot. ${coreInstructions().join(" ")} Stay on brand.`);
  });

  test("a persona template without the marker still gets the CORE appended (non-bypassable fail-safe)", () => {
    const template = "You are ACME's deployment co-pilot.";
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], { instructionsTemplate: template });
    expect(agent.instructions).toBe(`${template} ${coreInstructions().join(" ")}`);
    expect(agent.instructions).toContain("opengeni__goal_complete");
  });

  test("the per-call override beats the deployment-default template", () => {
    const settings = testSettings({ sandboxBackend: "none", agentInstructionsTemplate: `DEPLOY DEFAULT ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}` });
    const withoutOverride = buildOpenGeniAgent(settings, []);
    expect(withoutOverride.instructions.startsWith("DEPLOY DEFAULT ")).toBe(true);
    const withOverride = buildOpenGeniAgent(settings, [], { instructionsTemplate: `WORKSPACE OVERRIDE ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}` });
    expect(withOverride.instructions.startsWith("WORKSPACE OVERRIDE ")).toBe(true);
    expect(withOverride.instructions).not.toContain("DEPLOY DEFAULT");
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

  test("emits manifests without extra path grants so remote sandbox clients accept them", () => {
    // Modal's sandbox client rejects any manifest carrying extraPathGrants at
    // create/apply time; the bundled-skills source must not reintroduce one.
    const modalManifest = buildManifest(testSettings({ sandboxBackend: "modal" }), [{
      kind: "repository",
      uri: "https://github.com/acme/private.git",
      ref: "main",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    }]);
    expect(modalManifest.extraPathGrants).toEqual([]);
    expect(buildManifest(testSettings(), []).extraPathGrants).toEqual([]);
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
    expect(command).toContain("git -C \"$target\" rev-parse --is-inside-work-tree >/dev/null");
    expect(command).toContain("Repository resource ready at $target");
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

  test("fails repository clone hook when sandbox command is still running", async () => {
    const events: string[] = [];
    await expect(runRepositoryCloneHook({
      execCommand: async () => [
        "Chunk ID: abc123",
        "Wall time: 1.0000 seconds",
        "Process running with session ID 1",
        "Output:",
        "",
      ].join("\n"),
    } as any, [{
      kind: "repository",
      uri: "https://github.com/acme/private.git",
      ref: "main",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    }], {
      environment: { GH_TOKEN: "secret-token" },
      onRuntimeEvent: (event) => {
        events.push(event.type);
      },
    })).rejects.toThrow("did not finish before the lifecycle command timeout");

    expect(events).toEqual(["sandbox.operation.started", "sandbox.operation.failed"]);
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

  test("sends configured credential headers to third-party MCP servers", async () => {
    const mcp = startTestMcpServer({ requiredHeaders: { "x-api-key": "capability-credential" } });
    const prepared = await prepareAgentTools(testSettings({
      mcpServers: [{
        id: "cap-secure",
        name: "Secure capability MCP",
        url: mcp.url,
        headers: { "x-api-key": "capability-credential" },
        cacheToolsList: false,
      }],
    }), [{ kind: "mcp", id: "cap-secure" }]);
    try {
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toContain("cap-secure__search_documents");
      const result = await prepared.mcpServers[0]!.callTool("cap-secure__search_documents", { query: "headers" });
      expect(JSON.stringify(result)).toContain("found document for headers");
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("connecting without the required credential headers fails", async () => {
    const mcp = startTestMcpServer({ requiredHeaders: { "x-api-key": "capability-credential" } });
    try {
      await expect(prepareAgentTools(testSettings({
        mcpServers: [{
          id: "cap-secure",
          name: "Secure capability MCP",
          url: mcp.url,
          cacheToolsList: false,
        }],
      }), [{ kind: "mcp", id: "cap-secure" }])).rejects.toThrow();
    } finally {
      mcp.close();
    }
  });

  test("does not bleed the permission-scoped first-party tools-list across sessions", async () => {
    // The Agents SDK caches tools/list in a process-global map keyed by MCP
    // server name. The built-in `opengeni` server has the same name for every
    // session in a worker process, and its tools/list is permission-scoped
    // (a manager session is granted tools a worker session is not). If that
    // server were cached, the first session to warm the cache would dictate
    // every later session's tool visibility regardless of permissions. This
    // test connects a worker-permission session FIRST (the ordering that
    // previously poisoned the cache) and then a manager-permission session,
    // and asserts the manager still sees its grant-only tool.
    const managerAuthorization = "Bearer manager-grant";
    const mcp = startTestMcpServer({
      // Mirror the production first-party server: the manager grant unlocks an
      // extra tool a worker grant never sees.
      toolsForAuthorization: (authorization) =>
        authorization === managerAuthorization ? ["session_create"] : [],
    });

    // Use the real config default for the opengeni server so a regression that
    // flips cacheToolsList back to true is caught here too.
    const opengeniDefault = getSettings().mcpServers.find((server) => server.id === "opengeni");
    expect(opengeniDefault).toBeDefined();

    const settingsForAuthorization = (authorization: string) => testSettings({
      mcpServers: [{
        id: "opengeni",
        name: opengeniDefault!.name,
        url: mcp.url,
        headers: { authorization },
        cacheToolsList: opengeniDefault!.cacheToolsList,
      }],
    });

    const toolNamesFor = async (authorization: string): Promise<string[]> => {
      const prepared = await prepareAgentTools(settingsForAuthorization(authorization), [{ kind: "mcp", id: "opengeni" }]);
      try {
        // Drive the exact code path the agent runner uses (getAllMcpTools),
        // which is what populates the process-global cache.
        const tools = await getAllMcpTools({ mcpServers: prepared.mcpServers });
        return tools.map((tool) => tool.name).sort();
      } finally {
        await prepared.close();
      }
    };

    // Start from a clean process-global cache: other tests in this process may
    // have warmed the `opengeni` cache key.
    await invalidateServerToolsCache("opengeni");

    try {
      const workerTools = await toolNamesFor("Bearer worker-grant");
      expect(workerTools).not.toContain("opengeni__session_create");

      const managerTools = await toolNamesFor(managerAuthorization);
      expect(managerTools).toContain("opengeni__session_create");
    } finally {
      await invalidateServerToolsCache("opengeni");
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

describe("pack skills in the sandbox skill index", () => {
  const infraSkill = {
    name: "infra-ops",
    files: [
      { path: "SKILL.md", content: "---\nname: infra-ops\ndescription: Operate workspace infrastructure.\n---\n# Infra ops\n" },
      { path: "references/runbook.md", content: "Runbook." },
    ],
  };
  const emptyManifest = new Manifest({ root: "/workspace", entries: {}, environment: {} });

  test("without pack skills the source is the unchanged bundled local-dir source", () => {
    const source = lazySkillSourceWithPackSkills([]);
    expect((source.source as { type: string }).type).toBe("local_dir");
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    expect(index.map((entry) => entry.name)).toContain("checkov");
    expect(index.map((entry) => entry.name)).not.toContain("infra-ops");
  });

  test("pack skills join the bundled skills in one lazy skill index", () => {
    const source = lazySkillSourceWithPackSkills([infraSkill]);
    const sourceDir = source.source as { type: string; children: Record<string, any> };
    expect(sourceDir.type).toBe("dir");
    // Bundled skills stay lazily materializable from their local directories.
    expect(sourceDir.children.checkov.type).toBe("local_dir");
    // Pack skill content is carried in-memory from the manifest.
    expect(sourceDir.children["infra-ops"].type).toBe("dir");
    expect(sourceDir.children["infra-ops"].children["SKILL.md"].content).toContain("# Infra ops");
    expect(sourceDir.children["infra-ops"].children.references.children["runbook.md"].content).toBe("Runbook.");
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    const names = index.map((entry) => entry.name);
    expect(names).toContain("checkov");
    expect(names).toContain("infra-ops");
    const infra = index.find((entry) => entry.name === "infra-ops");
    expect(infra?.description).toBe("Operate workspace infrastructure.");
    expect(infra?.path).toBe("infra-ops");
  });

  test("an explicit pack skill description wins over SKILL.md frontmatter", () => {
    const source = lazySkillSourceWithPackSkills([{ ...infraSkill, description: "Explicit description." }]);
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    expect(index.find((entry) => entry.name === "infra-ops")?.description).toBe("Explicit description.");
  });

  test("a pack skill shadows a bundled skill with the same name", () => {
    const source = lazySkillSourceWithPackSkills([{
      name: "checkov",
      files: [{ path: "SKILL.md", content: "---\ndescription: Pack-provided checkov.\n---\n" }],
    }]);
    const sourceDir = source.source as { type: string; children: Record<string, any> };
    expect(sourceDir.children.checkov.type).toBe("dir");
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    const checkovEntries = index.filter((entry) => entry.name === "checkov");
    expect(checkovEntries).toHaveLength(1);
    expect(checkovEntries[0]?.description).toBe("Pack-provided checkov.");
  });

  test("rejects unsafe pack skill content instead of mounting it", () => {
    expect(() => lazySkillSourceWithPackSkills([{
      name: "bad",
      files: [{ path: "SKILL.md", content: "x" }, { path: "../escape.md", content: "x" }],
    }])).toThrow("Invalid pack skill file path");
    expect(() => lazySkillSourceWithPackSkills([{
      name: "no-entry",
      files: [{ path: "references/only.md", content: "x" }],
    }])).toThrow("missing a top-level SKILL.md");
    expect(() => lazySkillSourceWithPackSkills([
      { name: "dup", files: [{ path: "SKILL.md", content: "a" }] },
      { name: "dup", files: [{ path: "SKILL.md", content: "b" }] },
    ])).toThrow("Duplicate pack skill name");
    expect(() => lazySkillSourceWithPackSkills([{
      name: "bad/name",
      files: [{ path: "SKILL.md", content: "x" }],
    }])).toThrow("Invalid pack skill name");
  });

  test("buildOpenGeniAgent feeds pack skills through the SDK skills capability", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), [], { packSkills: [infraSkill] });
    const capabilities = (agent as any).capabilities as Array<{ type: string; lazyFrom?: { source: { type: string }; getIndex?: (manifest: unknown, skillsPath: string) => Array<{ name: string }> } }>;
    const skillsCapability = capabilities.find((capability) => capability.type === "skills");
    expect(skillsCapability?.lazyFrom?.source.type).toBe("dir");
    const index = skillsCapability?.lazyFrom?.getIndex?.(emptyManifest, ".agents") ?? [];
    expect(index.map((entry) => entry.name)).toContain("infra-ops");
    // Backward compatibility: without pack skills the capability keeps the
    // plain bundled local-dir source.
    const plainAgent = buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), []);
    const plainCapability = ((plainAgent as any).capabilities as Array<{ type: string; lazyFrom?: { source: { type: string } } }>).find((capability) => capability.type === "skills");
    expect(plainCapability?.lazyFrom?.source.type).toBe("local_dir");
  });
});

describe("provider item id stripping", () => {
  test("stripProviderItemIdsFilter removes provider ids from every item without touching pairing fields", () => {
    const reasoning = {
      type: "reasoning",
      id: "rs_dangling",
      content: [{ type: "input_text", text: "thinking" }],
      providerData: { encrypted_content: "gAAAA-opaque" },
    } as any;
    const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi" }] } as any;
    const functionCall = { type: "function_call", id: "fc_1", callId: "call_abc", name: "exec_command", arguments: "{}", status: "completed" } as any;
    const functionOutput = { type: "function_call_result", id: "fco_1", callId: "call_abc", status: "completed", output: { type: "text", text: "ok" } } as any;
    const userMessage = { type: "message", role: "user", content: "do the thing" } as any;
    const input = [reasoning, message, functionCall, functionOutput, userMessage];
    const result = stripProviderItemIdsFilter({
      modelData: { input, instructions: "be useful" },
      agent: undefined as any,
      context: undefined,
    }) as { input: any[]; instructions?: string };
    expect(result.instructions).toBe("be useful");
    expect(result.input).toHaveLength(5);
    for (const item of result.input) {
      expect("id" in item).toBe(false);
    }
    // Pairing and content stay intact.
    expect(result.input[0].providerData.encrypted_content).toBe("gAAAA-opaque");
    expect(result.input[2].callId).toBe("call_abc");
    expect(result.input[3].callId).toBe("call_abc");
    expect(result.input[4]).toBe(userMessage);
    // Originals are not mutated.
    expect(reasoning.id).toBe("rs_dangling");
    expect(message.id).toBe("msg_1");
  });

  test("callModelInputFilterForSettings always normalizes computer_calls and strips ids per policy", async () => {
    // The computer_call action/actions normalizer is ALWAYS on (Azure 400s
    // without it); the provider-item-id strip is layered on under the "strip"
    // policy. The filter is therefore always defined now.
    const conflictedComputerCall = {
      id: "cu_abc",
      type: "computer_call",
      callId: "cu_abc",
      status: "completed",
      action: { type: "screenshot" },
      actions: [{ type: "screenshot" }],
    };
    const runFilter = async (settings: ReturnType<typeof testSettings>) => {
      const filter = callModelInputFilterForSettings(settings);
      expect(filter).toBeDefined();
      const out = await filter!({
        modelData: { input: [{ ...conflictedComputerCall }] as any },
        agent: {} as any,
        context: undefined,
      });
      return out.input[0] as Record<string, unknown>;
    };

    // Default ("strip"): computer_call normalized to exactly `actions` (the GA
    // batched plural the Azure GA computer tool accepts), `action` dropped, id stripped.
    const stripped = await runFilter(testSettings());
    expect("actions" in stripped).toBe(true);
    expect("action" in stripped).toBe(false);
    expect("id" in stripped).toBe(false);

    // "preserve": computer_call still normalized, but provider id preserved.
    const preserved = await runFilter(testSettings({ openaiProviderItemIds: "preserve" }));
    expect("actions" in preserved).toBe(true);
    expect("action" in preserved).toBe(false);
    expect(preserved.id).toBe("cu_abc");
  });

  test("buildOpenGeniAgent requests encrypted reasoning content unless disabled", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect((agent as any).modelSettings.providerData).toEqual({ include: ["reasoning.encrypted_content"] });
    const disabled = buildOpenGeniAgent(testSettings({ sandboxBackend: "none", openaiReasoningEncryptedContent: false }), []);
    expect((disabled as any).modelSettings.providerData).toBeUndefined();
  });
});
