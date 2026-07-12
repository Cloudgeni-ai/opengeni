import { describe, expect, test } from "bun:test";
import {
  OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
  RunContext,
  RunRawModelStreamEvent,
  getAllMcpTools,
  invalidateServerToolsCache,
} from "@openai/agents";
import {
  AGENT_INSTRUCTIONS_CORE_PLACEHOLDER,
  DEFAULT_AGENT_INSTRUCTIONS,
  getSettings,
} from "@opengeni/config";
import { CLEARED_RUN_STATE_BLOB, verifyDelegatedAccessToken } from "@opengeni/contracts";
import {
  applyMissingManifestEntries,
  pinProvidedSessionManifestEnvironment,
  azureCliLoginCommand,
  azureOpenAIDefaultQuery,
  buildOpenGeniAgent,
  buildManifest,
  composeAgentInstructions,
  coreInstructions,
  appendToolspaceInstructions,
  appendWorkspaceMemory,
  TOOLSPACE_PROGRAMMATIC_DIRECTIVE,
  GENESIS_TITLE_DIRECTIVE,
  lazySkillSourceWithPackSkills,
  deserializeSandboxSessionStateEnvelope,
  ensureReadableStreamFrom,
  materializeSandboxFileDownloads,
  repositoryCloneCommand,
  repositoryUsesSandboxClone,
  mcpToolErrorOutput,
  modelCallUsageTelemetry,
  modelResponseUsageFromSdkEvent,
  normalizeSdkEvent,
  normalizeToolOutputForEvent,
  prepareRunInput,
  stripProviderItemIdsFilter,
  callModelInputFilterForSettings,
  prefixedMcpToolName,
  prepareAgentTools,
  runAzureCliLoginHook,
  runRepositoryCloneHook,
  runToolspaceTokenSeedHook,
  sandboxCommandExitCode,
  sandboxFileDownloadsForAgent,
  sandboxRunAs,
  toolspaceTokenSeedCommand,
  withSandboxFileDownloads,
  withSandboxLifecycleHooks,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
} from "../src/index";

import { Manifest } from "@openai/agents/sandbox";
import { startTestMcpServer, testSettings } from "@opengeni/testing";
import type { MCPServer } from "@openai/agents";
import {
  codexRequestStorage,
  type CodexRequestContext,
  type CodexTokenSnapshot,
} from "@opengeni/codex";

function makeCodexContext(
  overrides: { token?: CodexTokenSnapshot; tokenError?: Error } = {},
): CodexRequestContext {
  const token: CodexTokenSnapshot = overrides.token ?? {
    accessToken: "tok-123",
    chatgptAccountId: "acct-9",
    isFedramp: false,
  };
  return {
    clientVersion: "0.0.0-test",
    getToken: overrides.tokenError
      ? async () => {
          throw overrides.tokenError;
        }
      : async () => token,
    refresh: async () => token,
    resolveModel: (slug: string) => slug,
  };
}

const CODEX_APPS_ENTRY = (url: string) => ({
  id: "codex_apps",
  name: "codex_apps",
  url,
  cacheToolsList: false,
});

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
      "https://example.openai.azure.com/openai/deployments/gpt-5.6-sol",
    );

    expect(query).toEqual({ "api-version": "2025-04-01-preview" });
  });

  test("maps core SDK text deltas into session deltas", () => {
    const [event] = normalizeSdkEvent(
      new RunRawModelStreamEvent({
        type: "output_text_delta",
        delta: "hello",
      } as any),
    );

    expect(event).toEqual({
      type: "agent.message.delta",
      payload: { text: "hello" },
    });
  });

  test("extracts model usage from streamed response completion events", () => {
    const event = {
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
            outputTokensDetails: { reasoning_tokens: 2 },
          },
        },
      },
    } as any;
    const usage = modelResponseUsageFromSdkEvent(event);

    expect(usage).toEqual({
      responseId: "resp-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokensDetails: { cached_tokens: 3 },
        outputTokensDetails: { reasoning_tokens: 2 },
      },
    });
    expect(normalizeSdkEvent(event)).toEqual([
      {
        type: "agent.model.usage",
        payload: {
          responseId: "resp-1",
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 3,
          reasoningTokens: 2,
        },
      },
    ]);
  });

  test("extracts model usage from raw Responses completion events", () => {
    const event = new RunRawModelStreamEvent({
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
            output_tokens_details: { reasoning_tokens: 6 },
          },
        },
      },
    } as any);
    const usage = modelResponseUsageFromSdkEvent(event);

    expect(usage).toEqual({
      responseId: "resp-2",
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
        inputTokensDetails: { cached_tokens: 4 },
        outputTokensDetails: { reasoning_tokens: 6 },
      },
    });
    expect(normalizeSdkEvent(event)).toEqual([
      {
        type: "agent.model.usage",
        payload: {
          responseId: "resp-2",
          inputTokens: 20,
          outputTokens: 8,
          cachedTokens: 4,
          reasoningTokens: 6,
        },
      },
    ]);
  });

  test("normalizes model-call usage telemetry fields defensively", () => {
    expect(
      modelCallUsageTelemetry({
        inputTokens: 100,
        outputTokens: 20,
        inputTokensDetails: { cached_tokens: 80 },
        outputTokensDetails: { reasoning_tokens: 7 },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 80,
      reasoningTokens: 7,
    });
    expect(
      modelCallUsageTelemetry({
        inputTokens: 50,
        outputTokens: 10,
        inputTokensDetails: { cached_input_tokens: 30 },
      }),
    ).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cachedTokens: 30,
      reasoningTokens: null,
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
    const events = normalizeSdkEvent(
      new RunRawModelStreamEvent({
        type: "model",
        providerData: {
          rawModelEventSource: OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
        },
        event: {
          type: "response.reasoning_summary_text.delta",
          delta: "Checking credentials",
        },
      } as any),
    );

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

  test("compacts a codex computer_screenshot Uint8Array output to a data-URL string in the event", () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const [event] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        id: "item-shot",
        type: "tool_call_output_item",
        rawItem: { callId: "call-shot", type: "function_call_result" },
        output: { type: "image", image: { data: pngBytes, mediaType: "image/png" } },
      },
    } as any);

    expect(event?.type).toBe("agent.toolCall.output");
    const payload = event?.payload as { id: string; output: unknown };
    expect(payload.id).toBe("call-shot");
    expect(payload.output).toBe(
      `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}`,
    );
    // No raw typed-array / object-of-numbers survives into the serialized event.
    expect(JSON.stringify(event)).not.toContain('"0":137');
  });

  describe("normalizeToolOutputForEvent", () => {
    test("Uint8Array structured image → data-URL string", () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      expect(
        normalizeToolOutputForEvent({
          type: "image",
          image: { data: bytes, mediaType: "image/png" },
        }),
      ).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    });

    test("object-of-numbers (JSON-round-tripped Uint8Array) → data-URL string", () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const roundTripped = JSON.parse(
        JSON.stringify({ type: "image", image: { data: bytes, mediaType: "image/jpeg" } }),
      );
      expect(normalizeToolOutputForEvent(roundTripped)).toBe(
        `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
      );
    });

    test("defaults media type to image/png when absent", () => {
      const bytes = new Uint8Array([1, 2, 3]);
      expect(normalizeToolOutputForEvent({ type: "image", image: { data: bytes } })).toBe(
        `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
      );
    });

    test("base64 string / data-URL image data pass through as a data-URL", () => {
      expect(
        normalizeToolOutputForEvent({
          type: "image",
          image: { data: "aGk=", mediaType: "image/webp" },
        }),
      ).toBe("data:image/webp;base64,aGk=");
      expect(
        normalizeToolOutputForEvent({
          type: "image",
          image: { data: "data:image/png;base64,aGk=" },
        }),
      ).toBe("data:image/png;base64,aGk=");
    });

    test("already-normalized input_image content item → its data-URL", () => {
      expect(
        normalizeToolOutputForEvent({ type: "input_image", image: "data:image/png;base64,aGk=" }),
      ).toBe("data:image/png;base64,aGk=");
    });

    test("a single-image array unwraps to the bare data-URL string", () => {
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
      expect(
        normalizeToolOutputForEvent([
          { type: "image", image: { data: bytes, mediaType: "image/gif" } },
        ]),
      ).toBe(`data:image/gif;base64,${Buffer.from(bytes).toString("base64")}`);
    });

    test("text outputs pass through unchanged", () => {
      expect(normalizeToolOutputForEvent("plain tool output")).toBe("plain tool output");
      expect(normalizeToolOutputForEvent("data:image/png;base64,aGk=")).toBe(
        "data:image/png;base64,aGk=",
      );
    });

    test("hosted computer_call data-URL string output is unchanged", () => {
      const hosted = "data:image/png;base64,iVBORw0KGgo=";
      expect(normalizeToolOutputForEvent(hosted)).toBe(hosted);
    });

    test("MCP isError object output is unchanged", () => {
      const mcp = { isError: true, content: [{ type: "text", text: "delivery failed" }] };
      expect(normalizeToolOutputForEvent(mcp)).toEqual(mcp);
    });
  });

  describe("failed MCP tool calls carry an isError flag", () => {
    test("mcpToolErrorOutput shapes a thrown error as an MCP isError result", () => {
      const out = mcpToolErrorOutput(new Error("MCP error -32602: Invalid params"));
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toContain("-32602");
      // Non-Error values stringify rather than throwing.
      expect(mcpToolErrorOutput("boom").content[0]?.text).toContain("boom");
    });

    test("every agent gets an mcpConfig.errorFunction that produces isError output", () => {
      // Both agent paths share baseConfig, so both carry the errorFunction.
      for (const backend of ["none", "docker"] as const) {
        const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: backend }), []);
        const errorFunction = (agent as any).mcpConfig?.errorFunction as
          | ((args: { context: unknown; error: unknown }) => unknown)
          | undefined;
        expect(typeof errorFunction).toBe("function");
        // The runtime stores the raw return as the tool output; it must be an
        // isError object (not the SDK's flat default string) so the timeline
        // projection settles the tool to "failed".
        const produced = errorFunction!({ context: {}, error: new Error("boom") });
        expect((produced as { isError?: unknown }).isError).toBe(true);
      }
    });

    test("an isError tool output survives normalizeSdkEvent as the event output", () => {
      const errored = mcpToolErrorOutput(new Error("MCP error -32602: Invalid params"));
      const [event] = normalizeSdkEvent({
        type: "run_item_stream_event",
        item: {
          id: "item-err",
          type: "tool_call_output_item",
          rawItem: { callId: "call-err", type: "function_call_result" },
          output: errored,
        },
      } as any);
      expect(event?.type).toBe("agent.toolCall.output");
      const payload = event?.payload as { id: string; output: { isError?: unknown } };
      expect(payload.id).toBe("call-err");
      expect(payload.output.isError).toBe(true);
    });
  });

  describe("per-MCP-server tool approval policy", () => {
    type ApprovalAgent = {
      getMcpTools: (runContext: RunContext) => Promise<Awaited<ReturnType<typeof getAllMcpTools>>>;
    };

    // Resolves an agent's MCP tools and reports which prefixed tool names need
    // approval (invoking each tool's needsApproval predicate).
    async function approvalMapForAgent(agent: ApprovalAgent): Promise<Record<string, boolean>> {
      const tools = await agent.getMcpTools(new RunContext());
      const entries = await Promise.all(
        tools.map(async (tool) => {
          const needs =
            tool.type === "function"
              ? Boolean(
                  await (
                    tool.needsApproval as (
                      rc: unknown,
                      input: unknown,
                      details: unknown,
                    ) => boolean | Promise<boolean>
                  )(new RunContext(), "{}", {}),
                )
              : false;
          return [tool.name, needs] as const;
        }),
      );
      return Object.fromEntries(entries);
    }

    // Builds an agent with a real test MCP server ("docs": search_documents +
    // fetch_document) under the given requireApproval policy, then resolves the
    // agent's MCP tools and reports which prefixed tool names need approval.
    async function mcpToolApprovalMap(
      requireApproval: boolean | string[] | undefined,
    ): Promise<Record<string, boolean>> {
      const mcp = startTestMcpServer();
      const serverConfig = {
        id: "docs",
        name: "Document Search",
        url: mcp.url,
        cacheToolsList: false,
        ...(requireApproval !== undefined ? { requireApproval } : {}),
      };
      const prepared = await prepareAgentTools(testSettings({ mcpServers: [serverConfig] }), [
        { kind: "mcp", id: "docs" },
      ]);
      try {
        const agent = buildOpenGeniAgent(
          testSettings({ sandboxBackend: "none", mcpServers: [serverConfig] }),
          [],
          { mcpServers: prepared.mcpServers },
        );
        return await approvalMapForAgent(agent);
      } finally {
        await prepared.close();
        mcp.close();
      }
    }

    test("requireApproval: true → every tool of the server needs approval", async () => {
      const map = await mcpToolApprovalMap(true);
      expect(map).toEqual({ docs__search_documents: true, docs__fetch_document: true });
    });

    test("requireApproval: string[] → only the listed unprefixed tool needs approval", async () => {
      const map = await mcpToolApprovalMap(["fetch_document"]);
      expect(map).toEqual({ docs__search_documents: false, docs__fetch_document: true });
    });

    test("requireApproval absent → nothing needs approval (historical default)", async () => {
      const map = await mcpToolApprovalMap(undefined);
      expect(map).toEqual({ docs__search_documents: false, docs__fetch_document: false });
    });

    test("requireApproval survives the sandbox clone() tool-resolution path", async () => {
      const mcp = startTestMcpServer();
      const serverConfig = {
        id: "docs",
        name: "Document Search",
        url: mcp.url,
        cacheToolsList: false,
        requireApproval: true as const,
      };
      const prepared = await prepareAgentTools(testSettings({ mcpServers: [serverConfig] }), [
        { kind: "mcp", id: "docs" },
      ]);
      try {
        const agent = buildOpenGeniAgent(
          // Sandbox backend → a SandboxAgent, whose tools are resolved on a fresh
          // clone (prepareSandboxAgent), NOT on this instance.
          testSettings({ sandboxBackend: "modal", mcpServers: [serverConfig] }),
          [],
          { mcpServers: prepared.mcpServers },
        );
        // Mirror the sandbox runtime: it calls agent.clone(...) and resolves tools
        // on the CLONE. SandboxAgent.clone reconstructs from a fixed field list, so
        // an instance-own getMcpTools override is dropped — approval must be
        // re-installed onto the clone or it silently bypasses on every sandbox turn.
        const clone = (agent as unknown as { clone: (config: unknown) => ApprovalAgent }).clone({});
        expect(await approvalMapForAgent(clone)).toEqual({
          docs__search_documents: true,
          docs__fetch_document: true,
        });
        // clone-of-clone (resume paths) must keep the policy too.
        const grandchild = (
          clone as unknown as { clone: (config: unknown) => ApprovalAgent }
        ).clone({});
        expect(await approvalMapForAgent(grandchild)).toEqual({
          docs__search_documents: true,
          docs__fetch_document: true,
        });
      } finally {
        await prepared.close();
        mcp.close();
      }
    });

    test("prefix-colliding server ids resolve each tool to ITS OWN server's policy", async () => {
      const outer = startTestMcpServer();
      const inner = startTestMcpServer();
      // Server ids where one is a prefix of the other, so their tool prefixes
      // collide: `my__` (outer) is a prefix of `my___` (inner). A tool like
      // `my___fetch_document` (inner) also startsWith `my__` (outer).
      const outerConfig = {
        id: "my",
        name: "Outer",
        url: outer.url,
        cacheToolsList: false,
        requireApproval: ["search_documents"],
      };
      const innerConfig = {
        id: "my_",
        name: "Inner",
        url: inner.url,
        cacheToolsList: false,
        requireApproval: true as const,
      };
      // Order [outer, inner] puts the SHORTER (colliding) prefix first, so a
      // first-match find over UNSORTED policies would mis-bind inner's tools to
      // outer's narrower policy and bypass gating on my___fetch_document.
      const settings = testSettings({
        sandboxBackend: "none",
        mcpServers: [outerConfig, innerConfig],
      });
      const prepared = await prepareAgentTools(settings, [
        { kind: "mcp", id: "my" },
        { kind: "mcp", id: "my_" },
      ]);
      try {
        const agent = buildOpenGeniAgent(settings, [], { mcpServers: prepared.mcpServers });
        expect(await approvalMapForAgent(agent)).toEqual({
          // outer ("my"): only search_documents is gated.
          my__search_documents: true,
          my__fetch_document: false,
          // inner ("my_"): ALL tools gated — must NOT inherit outer's narrower
          // policy via the colliding prefix.
          my___search_documents: true,
          my___fetch_document: true,
        });
      } finally {
        await prepared.close();
        outer.close();
        inner.close();
      }
    });
  });

  test("uses normal Azure CLI service principal login hook", () => {
    const command = azureCliLoginCommand();
    expect(command).toContain("export HOME=");
    expect(command).toContain('mkdir -p "$HOME/.azure"');
    expect(command).toContain("command -v az");
    expect(command).toContain("az login --service-principal");
    expect(command).toContain("az account set --subscription");
    expect(command).not.toContain("opengeni-azure-login");
    expect(command).not.toContain("AZURE_CONFIG_DIR");
  });

  test("runs Azure CLI login hook as the sandbox agent user", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runAzureCliLoginHook(
      {
        execCommand: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { status: 0, output: "" };
        },
      } as any,
      { environment: {}, runAs: "sandbox" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.runAs).toBe("sandbox");
    expect(calls[0]?.workdir).toBe("/workspace");
  });

  test("emits lifecycle hook failure events", async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    await expect(
      runAzureCliLoginHook(
        {
          execCommand: async () => ({ status: 1, output: "login failed" }),
        } as any,
        {
          environment: {},
          onRuntimeEvent: (event) => {
            events.push(event);
          },
        },
      ),
    ).rejects.toThrow("login failed");
    expect(events.map((event) => event.type)).toEqual([
      "sandbox.operation.started",
      "sandbox.operation.failed",
    ]);
  });

  test("runs sandbox lifecycle hooks once per session object", async () => {
    const session = {};
    let runs = 0;
    const client = withSandboxLifecycleHooks(
      {
        backendId: "test",
        create: async () => session,
        resume: async () => session,
      } as any,
      [
        {
          id: "test-hook",
          phase: "beforeAgentStart",
          run: async () => {
            runs += 1;
          },
        },
      ],
      { environment: {} },
    );

    await (client.create as any)();
    await client.resume!({} as any);

    expect(runs).toBe(1);
  });

  test("retries sandbox lifecycle hooks after a failed attempt on the same session object", async () => {
    const session = {};
    let runs = 0;
    const client = withSandboxLifecycleHooks(
      {
        backendId: "test",
        create: async () => session,
        resume: async () => session,
      } as any,
      [
        {
          id: "test-hook",
          phase: "beforeAgentStart",
          run: async () => {
            runs += 1;
            if (runs === 1) {
              throw new Error("hook failed");
            }
          },
        },
      ],
      { environment: {} },
    );

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
    const prepared = await prepareRunInput(
      buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []),
      {
        kind: "message",
        text: "hello",
        serializedRunState: null,
      },
    );
    expect(prepared.input).toBe("hello");
  });

  test("treats the cleared run-state sentinel as a fresh start (run_state mode /clear)", async () => {
    // Regression (adversarial review): after /clear, in run_state history mode
    // the message path reads the cleared sentinel blob (not a real serialized
    // run state — it has no $schemaVersion). RunState.fromString would throw
    // "Run state is missing schema version" and break the next turn. The reader
    // must recognize the sentinel and start clean instead, returning the bare
    // text exactly as a null state would.
    const prepared = await prepareRunInput(
      buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []),
      {
        kind: "message",
        text: "first message after clear",
        serializedRunState: CLEARED_RUN_STATE_BLOB,
      },
    );
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
    const orphan = {
      type: "function_call_result",
      callId: "call_orphan",
      output: { type: "text", text: "stale" },
    };
    const validCall = { type: "function_call", callId: "call_ok", name: "tool", arguments: "{}" };
    const validResult = {
      type: "function_call_result",
      callId: "call_ok",
      output: { type: "text", text: "ok" },
    };
    const prepared = await prepareRunInput(
      buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []),
      {
        kind: "message",
        text: "continue",
        historyItems: [
          { type: "message", role: "user", content: "earlier" } as any,
          orphan as any,
          validCall as any,
          validResult as any,
        ],
      },
    );
    const input = prepared.input as Array<Record<string, unknown>>;
    expect(Array.isArray(input)).toBe(true);
    // The orphan is gone; the valid pair and the new user turn remain in order.
    expect(input.filter((item) => item.type === "function_call_result")).toEqual([validResult]);
    expect(
      input.some((item) => item.type === "function_call_result" && item.callId === "call_orphan"),
    ).toBe(false);
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
    expect(
      (buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), []) as any).runAs,
    ).toBeUndefined();
    expect(
      (buildOpenGeniAgent(testSettings({ sandboxBackend: "local" }), []) as any).runAs,
    ).toBeUndefined();
    expect(
      (buildOpenGeniAgent(testSettings({ sandboxBackend: "modal" }), []) as any).runAs,
    ).toBeUndefined();
    expect(
      (buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []) as any).runAs,
    ).toBeUndefined();
  });

  test("includes read-only attachment guidance in agent instructions", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(agent.instructions).toContain(
      "Attached files are mounted read-only; copy them before modifying.",
    );
  });

  test("surfaces attached workspace environment metadata in agent instructions", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      workspaceEnvironment: {
        name: "azure-prod",
        description: "Clone the journal repo over SSH with JOURNAL_DEPLOY_KEY.",
        variableNames: ["JOURNAL_DEPLOY_KEY", "ARM_CLIENT_ID"],
      },
    });
    expect(agent.instructions).toContain(
      'A workspace environment named "azure-prod" is attached to this session',
    );
    expect(agent.instructions).toContain(
      "Exported environment variables: ARM_CLIENT_ID, JOURNAL_DEPLOY_KEY.",
    );
    expect(agent.instructions).toContain(
      "Environment notes from the operator: Clone the journal repo over SSH with JOURNAL_DEPLOY_KEY.",
    );
  });

  test("omits workspace environment instructions when no environment is attached or metadata is empty", () => {
    const detached = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(detached.instructions).not.toContain("A workspace environment named");

    const minimal = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      workspaceEnvironment: { name: "bare", description: "  ", variableNames: [] },
    });
    expect(minimal.instructions).toContain(
      'A workspace environment named "bare" is attached to this session',
    );
    expect(minimal.instructions).not.toContain("Exported environment variables:");
    expect(minimal.instructions).not.toContain("Environment notes from the operator:");
  });

  // THE GATE. The exact default preamble buildOpenGeniAgent produces with no
  // workspace environment, joined by " ". Captured verbatim; the composed
  // default MUST equal it byte-for-byte so instruction-template changes are
  // intentional. When the product intentionally changes the default substrate
  // guidance, update this pin as the new canonical default rather than
  // weakening the absent-memory/per-session no-op assertions below.
  const HISTORICAL_DEFAULT_INSTRUCTIONS = [
    "You are an OpenGeni workspace agent.",
    "Follow the user's task and any enabled pack or skill instructions for the current role.",
    "Work inside the sandbox workspace and use filesystem and shell tools when useful.",
    "Repository resources are mounted under repos/<owner>/<repo>.",
    "File resources are mounted under files/<file-id>/ unless the session specifies another mount path.",
    "Attached files are mounted read-only; copy them before modifying.",
    "Bundled skills are under .agents/ and can include infrastructure, marketing, or other role-specific guidance.",
    "Use Checkov, Terraform, Azure CLI, git provider CLIs, and repository tools when relevant; gh, glab, and az repos are pre-authenticated when the host brokers matching git credentials.",
    "When the Azure sandbox preparation profile is enabled and service-principal variables are present, the sandbox is pre-authenticated with normal Azure CLI before work starts.",
    "Treat code-changing work as GitOps work: create a focused branch/commit/PR when git provider credentials are available; otherwise report exact commands and blockers.",
    "Return concise, factual summaries with files changed, commands run, and remaining blockers.",
    "If the session has a goal, you own it: keep working until you call opengeni__goal_complete with concrete evidence or opengeni__goal_pause with a rationale; revise it with opengeni__goal_update; create one with opengeni__goal_set when given a long-running objective.",
  ].join(" ");

  test("default template composes byte-identically to the pinned default preamble (no override, no environment)", () => {
    // Direct composition: default template + empty CORE-with-no-env.
    expect(composeAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS)).toBe(
      HISTORICAL_DEFAULT_INSTRUCTIONS,
    );
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
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      workspaceEnvironment: env,
    });
    expect(agent.instructions).toBe(expected);
  });

  test("a white-label persona override is substituted at {{core}} but keeps the non-bypassable CORE", () => {
    const template = `You are ACME's deployment co-pilot. ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER} Stay on brand.`;
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      instructionsTemplate: template,
    });
    expect(agent.instructions).toContain("You are ACME's deployment co-pilot.");
    expect(agent.instructions).not.toContain("You are an OpenGeni workspace agent.");
    // CORE (the goal-loop ownership line naming opengeni__goal_*) survives.
    expect(agent.instructions).toContain("you call opengeni__goal_complete with concrete evidence");
    expect(agent.instructions).toBe(
      `You are ACME's deployment co-pilot. ${coreInstructions().join(" ")} Stay on brand.`,
    );
  });

  test("a persona template without the marker still gets the CORE appended (non-bypassable fail-safe)", () => {
    const template = "You are ACME's deployment co-pilot.";
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      instructionsTemplate: template,
    });
    expect(agent.instructions).toBe(`${template} ${coreInstructions().join(" ")}`);
    expect(agent.instructions).toContain("opengeni__goal_complete");
  });

  test("the per-call override beats the deployment-default template", () => {
    const settings = testSettings({
      sandboxBackend: "none",
      agentInstructionsTemplate: `DEPLOY DEFAULT ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}`,
    });
    const withoutOverride = buildOpenGeniAgent(settings, []);
    expect(withoutOverride.instructions.startsWith("DEPLOY DEFAULT ")).toBe(true);
    const withOverride = buildOpenGeniAgent(settings, [], {
      instructionsTemplate: `WORKSPACE OVERRIDE ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}`,
    });
    expect(withOverride.instructions.startsWith("WORKSPACE OVERRIDE ")).toBe(true);
    expect(withOverride.instructions).not.toContain("DEPLOY DEFAULT");
  });

  test("per-session instructions compose AFTER the workspace persona + CORE (session-specific last)", () => {
    const template = `WORKSPACE PERSONA ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}`;
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      instructionsTemplate: template,
      sessionInstructions: "SESSION RULE: always answer in French.",
    });
    // Exact ordering: workspace persona + CORE first, session instructions last.
    expect(agent.instructions).toBe(
      `WORKSPACE PERSONA ${coreInstructions().join(" ")} SESSION RULE: always answer in French.`,
    );
    // And it rides the same instructions string (system-level), never a message.
    expect(agent.instructions.endsWith("SESSION RULE: always answer in French.")).toBe(true);
  });

  test("per-session instructions layer onto the DEFAULT persona too (no workspace override)", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      sessionInstructions: "Be terse.",
    });
    expect(agent.instructions).toBe(`${HISTORICAL_DEFAULT_INSTRUCTIONS} Be terse.`);
  });

  test("absent per-session instructions are byte-identical to today's composition", () => {
    const base = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    const withUndefined = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      sessionInstructions: undefined,
    });
    // A blank/whitespace-only value is also a no-op (trimmed to nothing).
    const withBlank = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      sessionInstructions: "   ",
    });
    expect(withUndefined.instructions).toBe(base.instructions);
    expect(withBlank.instructions).toBe(base.instructions);
    expect(base.instructions).toBe(HISTORICAL_DEFAULT_INSTRUCTIONS);
  });

  test("absent workspace memory is byte-identical to today's composition", () => {
    expect(appendWorkspaceMemory("base")).toBe("base");
    expect(appendWorkspaceMemory("base", "   ")).toBe("base");

    const base = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    const withUndefined = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      workspaceMemory: undefined,
    });
    const withBlank = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      workspaceMemory: "   ",
    });
    expect(withUndefined.instructions).toBe(base.instructions);
    expect(withBlank.instructions).toBe(base.instructions);
    expect(base.instructions).toBe(HISTORICAL_DEFAULT_INSTRUCTIONS);
  });

  test("workspace memory composes after workspace persona + CORE and before per-session instructions", () => {
    const template = `WORKSPACE PERSONA ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}`;
    const workspaceMemory = "## Workspace memory\n- [abcd1234] Prefer Terraform over Pulumi.";
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      instructionsTemplate: template,
      workspaceMemory,
      sessionInstructions: "SESSION RULE: always answer in French.",
    });

    expect(agent.instructions).toBe(
      `WORKSPACE PERSONA ${coreInstructions().join(" ")} ${workspaceMemory} SESSION RULE: always answer in French.`,
    );
    expect(agent.instructions.indexOf(workspaceMemory)).toBeLessThan(
      agent.instructions.indexOf("SESSION RULE"),
    );
  });

  test("the genesis title directive stays LAST, after per-session instructions", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      sessionInstructions: "Session-scoped rule.",
      genesisTitleHint: true,
    });
    expect(agent.instructions).toContain("Session-scoped rule.");
    // Genesis directive is appended after everything, including the session slice.
    expect(agent.instructions.endsWith(GENESIS_TITLE_DIRECTIVE)).toBe(true);
    expect(agent.instructions.indexOf("Session-scoped rule.")).toBeLessThan(
      agent.instructions.indexOf(GENESIS_TITLE_DIRECTIVE),
    );
  });

  // ── generic programmatic-tool-calling (toolspace) substrate directive ──────
  // The block is GENERIC substrate prompting, gated by the SAME condition that
  // gates the sandbox token mint: toolspaceEnabled AND a toolspace token minted
  // for this turn (surfaced to the runtime as options.toolspaceTokenSeed, which
  // the worker passes only for a non-selfhosted, non-skipped turn).
  const toolspaceOn = { sandboxBackend: "none", toolspaceEnabled: true } as const;

  test("the toolspace directive is present exactly when the feature is on AND a token was minted", () => {
    const agent = buildOpenGeniAgent(testSettings(toolspaceOn), [], {
      toolspaceTokenSeed: "ogd_seed",
    });
    expect(agent.instructions).toContain(TOOLSPACE_PROGRAMMATIC_DIRECTIVE);
    // Default (feature off, no seed) never carries it — the historical preamble.
    const off = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(off.instructions).toBe(HISTORICAL_DEFAULT_INSTRUCTIONS);
    expect(off.instructions).not.toContain(TOOLSPACE_PROGRAMMATIC_DIRECTIVE);
  });

  test("NEGATIVE: feature flag off (even with a token seed) omits the directive", () => {
    const agent = buildOpenGeniAgent(
      testSettings({ sandboxBackend: "none", toolspaceEnabled: false }),
      [],
      {
        toolspaceTokenSeed: "ogd_seed",
      },
    );
    expect(agent.instructions).not.toContain(TOOLSPACE_PROGRAMMATIC_DIRECTIVE);
    expect(agent.instructions).toBe(HISTORICAL_DEFAULT_INSTRUCTIONS);
  });

  test("NEGATIVE: feature on but no token minted for the turn omits the directive", () => {
    // The block gates on the per-turn seed, not the flag alone: a turn with no
    // minted toolspace token (the worker passed no seed) has no ogtool/URL in its
    // sandbox, so the block must not advertise it. The mint now happens on every
    // backend including selfhosted, so this is the genuine no-token case, not a
    // backend distinction.
    const agent = buildOpenGeniAgent(testSettings(toolspaceOn), []);
    expect(agent.instructions).not.toContain(TOOLSPACE_PROGRAMMATIC_DIRECTIVE);
    expect(agent.instructions).toBe(HISTORICAL_DEFAULT_INSTRUCTIONS);
  });

  test("the toolspace directive composes AFTER the workspace persona + CORE but BEFORE the per-session slice", () => {
    const template = `WORKSPACE PERSONA ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}`;
    const agent = buildOpenGeniAgent(testSettings(toolspaceOn), [], {
      instructionsTemplate: template,
      sessionInstructions: "SESSION RULE: always answer in French.",
      toolspaceTokenSeed: "ogd_seed",
    });
    // Exact ordering: workspace persona + CORE, then the toolspace directive,
    // then the session slice last (host/session specificity wins).
    expect(agent.instructions).toBe(
      `WORKSPACE PERSONA ${coreInstructions().join(" ")} ${TOOLSPACE_PROGRAMMATIC_DIRECTIVE} SESSION RULE: always answer in French.`,
    );
    expect(agent.instructions.indexOf(TOOLSPACE_PROGRAMMATIC_DIRECTIVE)).toBeLessThan(
      agent.instructions.indexOf("SESSION RULE"),
    );
  });

  test("workspace memory composes after the toolspace directive and before the per-session slice", () => {
    const template = `WORKSPACE PERSONA ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}`;
    const workspaceMemory = "## Workspace memory\n- [abcd1234] Prefer Terraform over Pulumi.";
    const agent = buildOpenGeniAgent(testSettings(toolspaceOn), [], {
      instructionsTemplate: template,
      workspaceMemory,
      sessionInstructions: "SESSION RULE: always answer in French.",
      toolspaceTokenSeed: "ogd_seed",
    });

    expect(agent.instructions).toBe(
      `WORKSPACE PERSONA ${coreInstructions().join(" ")} ${TOOLSPACE_PROGRAMMATIC_DIRECTIVE} ${workspaceMemory} SESSION RULE: always answer in French.`,
    );
    expect(agent.instructions.indexOf(TOOLSPACE_PROGRAMMATIC_DIRECTIVE)).toBeLessThan(
      agent.instructions.indexOf(workspaceMemory),
    );
    expect(agent.instructions.indexOf(workspaceMemory)).toBeLessThan(
      agent.instructions.indexOf("SESSION RULE"),
    );
  });

  test("the toolspace directive stays before the genesis directive, which remains LAST", () => {
    const agent = buildOpenGeniAgent(testSettings(toolspaceOn), [], {
      sessionInstructions: "Session-scoped rule.",
      genesisTitleHint: true,
      toolspaceTokenSeed: "ogd_seed",
    });
    expect(agent.instructions).toContain(TOOLSPACE_PROGRAMMATIC_DIRECTIVE);
    expect(agent.instructions.endsWith(GENESIS_TITLE_DIRECTIVE)).toBe(true);
    expect(agent.instructions.indexOf(TOOLSPACE_PROGRAMMATIC_DIRECTIVE)).toBeLessThan(
      agent.instructions.indexOf("Session-scoped rule."),
    );
    expect(agent.instructions.indexOf("Session-scoped rule.")).toBeLessThan(
      agent.instructions.indexOf(GENESIS_TITLE_DIRECTIVE),
    );
  });

  test("appendToolspaceInstructions joins by space and no-ops when unavailable", () => {
    expect(appendToolspaceInstructions("BASE", true)).toBe(
      `BASE ${TOOLSPACE_PROGRAMMATIC_DIRECTIVE}`,
    );
    expect(appendToolspaceInstructions("BASE", false)).toBe("BASE");
  });

  test("the toolspace directive text is a stable, generic, host-agnostic snapshot", () => {
    // Pinned verbatim so an unintended edit to the substrate prompt fails here.
    // It must name only generic substrate handles (ogtool, $OPENGENI_TOOLSPACE_*),
    // never a host/product name.
    expect(TOOLSPACE_PROGRAMMATIC_DIRECTIVE).toBe(
      "Every tool on your MCP surface is also callable programmatically from the sandbox shell, so scripts can invoke tools without a model round trip per call. Run `ogtool list` to see the available tools and their input schemas (from tools/list), then `ogtool call <tool-name> '<json-args>'`; equivalently, POST MCP JSON-RPC to $OPENGENI_TOOLSPACE_URL with the bearer token read from $OPENGENI_TOOLSPACE_TOKEN_FILE. Prefer programmatic calls for loops, polling, and bulk filtering: their results stay in the sandbox and do not consume your context window. Tools that require human approval must still be invoked normally — called programmatically they return a typed error.",
    );
  });

  test("builds native S3 mount entries for file resources", () => {
    const fileId = "00000000-0000-4000-8000-000000000010";
    const manifest = buildManifest(
      testSettings({
        objectStorageEndpoint: "http://127.0.0.1:9000",
        objectStorageSandboxEndpoint: "http://host.docker.internal:9000",
        objectStorageAccessKeyId: "minioadmin",
        objectStorageSecretAccessKey: "minioadmin",
      }),
      [{ kind: "file", fileId }],
    );
    const entry = manifest.entries[`files/${fileId}`] as any;
    expect(entry.type).toBe("s3_mount");
    expect(entry.bucket).toBe("opengeni-files");
    expect(entry.prefix).toBe(`files/${fileId}/original`);
    expect(entry.endpointUrl).toBe("http://host.docker.internal:9000");
    expect(entry.s3Provider).toBe("Minio");
    expect(entry.mountStrategy).toEqual({
      type: "in_container",
      pattern: { type: "rclone", mode: "fuse" },
    });
  });

  test("uses Modal cloud bucket strategy for Modal S3-compatible file resources", () => {
    const fileId = "00000000-0000-4000-8000-000000000011";
    const manifest = buildManifest(
      testSettings({
        sandboxBackend: "modal",
        objectStorageEndpoint: "https://s3.example.com",
        objectStorageAccessKeyId: "access-key",
        objectStorageSecretAccessKey: "secret-key",
      }),
      [{ kind: "file", fileId }],
    );
    const entry = manifest.entries[`files/${fileId}`] as any;
    expect(entry.type).toBe("s3_mount");
    expect(entry.mountStrategy).toMatchObject({ type: "modal_cloud_bucket" });
  });

  test("builds native Azure Blob mount entries for file resources", () => {
    const fileId = "00000000-0000-4000-8000-000000000020";
    const manifest = buildManifest(
      testSettings({
        objectStorageBackend: "azure-blob",
        objectStorageAzureConnectionString:
          "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=secret;BlobEndpoint=https://acct.blob.core.windows.net/",
      }),
      [{ kind: "file", fileId }],
    );
    const entry = manifest.entries[`files/${fileId}`] as any;
    expect(entry.type).toBe("azure_blob_mount");
    expect(entry.container).toBe("opengeni-files");
    expect(entry.prefix).toBe(`files/${fileId}/original`);
    expect(entry.accountName).toBe("acct");
    expect(entry.accountKey).toBe("secret");
    expect(entry.endpointUrl).toBeUndefined();
    expect(entry.mountStrategy).toEqual({
      type: "in_container",
      pattern: { type: "rclone", mode: "fuse" },
    });
  });

  test("keeps custom Azure Blob mount endpoints for non-standard storage hosts", () => {
    const fileId = "00000000-0000-4000-8000-000000000022";
    const manifest = buildManifest(
      testSettings({
        objectStorageBackend: "azure-blob",
        objectStorageAzureConnectionString:
          "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=secret;BlobEndpoint=https://custom.blob.example.test/",
      }),
      [{ kind: "file", fileId }],
    );
    const entry = manifest.entries[`files/${fileId}`] as any;
    expect(entry.type).toBe("azure_blob_mount");
    expect(entry.endpointUrl).toBe("https://custom.blob.example.test");
  });

  test("requires signed download materialization for Modal Azure Blob file resources", () => {
    const fileId = "00000000-0000-4000-8000-000000000021";
    expect(() =>
      buildManifest(
        testSettings({
          sandboxBackend: "modal",
          objectStorageBackend: "azure-blob",
          objectStorageAzureConnectionString:
            "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=secret;BlobEndpoint=https://acct.blob.core.windows.net/",
        }),
        [{ kind: "file", fileId }],
      ),
    ).toThrow(
      "Modal sandbox Azure Blob file resources require pre-signed download materialization",
    );
  });

  test("uses inline manifest files for Modal Azure Blob file materialization when content is provided", () => {
    const fileId = "00000000-0000-4000-8000-000000000023";
    const settings = testSettings({
      sandboxBackend: "modal",
      objectStorageBackend: "azure-blob",
      objectStorageAzureConnectionString:
        "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=secret;BlobEndpoint=https://acct.blob.core.windows.net/",
    });
    const downloads = [
      {
        fileId,
        mountPath: `files/${fileId}`,
        filename: "source.txt",
        content: new TextEncoder().encode("hello"),
        sizeBytes: 12,
      },
    ];
    const manifest = buildManifest(settings, [{ kind: "file", fileId }], undefined, downloads);
    const entry = manifest.entries[`files/${fileId}`] as any;
    const agent = buildOpenGeniAgent(settings, [{ kind: "file", fileId }], {
      fileResourceDownloads: downloads,
    });

    expect(entry.type).toBe("dir");
    expect(entry.children["source.txt"].type).toBe("file");
    expect(new TextDecoder().decode(entry.children["source.txt"].content)).toBe("hello");
    expect(sandboxFileDownloadsForAgent(agent)).toEqual([]);
    expect((agent as any).defaultManifest.entries[`files/${fileId}`].type).toBe("dir");
  });

  test("downloads signed file resources before sandbox use without emitting URLs in events", async () => {
    const commands: string[] = [];
    const events: string[] = [];
    await materializeSandboxFileDownloads(
      {
        state: { manifest: new Manifest({ root: "/workspace" }) },
        exec: async ({ cmd }: { cmd: string }) => {
          commands.push(cmd);
          return { output: "", stdout: "", stderr: "", wallTimeSeconds: 0, exitCode: 0 };
        },
      } as any,
      [
        {
          fileId: "file-1",
          mountPath: "files/file-1",
          filename: "input.txt",
          url: "https://storage.example/input.txt?sig=secret",
          sizeBytes: 5,
        },
      ],
      {
        onRuntimeEvent: (event) => {
          events.push(JSON.stringify(event));
        },
      },
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("set -eu");
    expect(commands[0]).not.toContain("pipefail");
    expect(commands[0]).toContain("curl --fail");
    expect(commands[0]).toContain("chmod a-w");
    expect(commands[0]).toContain("https://storage.example/input.txt?sig=secret");
    expect(events.join("\n")).not.toContain("sig=secret");
    expect(events.join("\n")).toContain("file-resource-download");
  });

  test("reports signed file download failures without throwing", async () => {
    const events: Array<{ type: string; payload: any }> = [];
    const result = await materializeSandboxFileDownloads(
      {
        state: { manifest: new Manifest({ root: "/workspace" }) },
        execCommand: async () =>
          [
            "Chunk ID: abc123",
            "Wall time: 0.0000 seconds",
            "Process exited with code 2",
            "Output:",
            "/bin/sh: 1: set: Illegal option -o pipefail",
          ].join("\n"),
      } as any,
      [
        {
          fileId: "file-1",
          mountPath: "files/file-1",
          filename: "input.txt",
          url: "https://storage.example/input.txt?sig=secret",
          sizeBytes: 5,
        },
      ],
      {
        onRuntimeEvent: (event) => {
          events.push(event as any);
        },
      },
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.filename).toBe("input.txt");
    expect(result.failures[0]?.exitCode).toBe(2);
    expect(result.failures[0]?.reason).toContain("failed with exit code 2");
    expect(result.failures[0]?.reason).toContain("Illegal option");
    expect(events.map((event) => event.type)).toEqual([
      "sandbox.operation.started",
      "sandbox.operation.failed",
    ]);
    expect(events[1]?.payload.exitCode).toBe(2);
    expect(events[1]?.payload.error).toContain("Illegal option");
    expect(JSON.stringify(events)).not.toContain("sig=secret");
  });

  test("wraps sandbox clients with signed file downloads on create and resume", async () => {
    const sessions: any[] = [];
    const baseClient = {
      backendId: "modal",
      create: async () => {
        const session = {
          state: { manifest: new Manifest({ root: "/workspace" }) },
          execCommand: async () =>
            "Chunk ID: abc123\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\n",
        };
        sessions.push(session);
        return session;
      },
      resume: async (state: any) => {
        const session = {
          state,
          execCommand: async () =>
            "Chunk ID: abc123\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\n",
        };
        sessions.push(session);
        return session;
      },
    };
    const client = withSandboxFileDownloads(baseClient as any, [
      {
        fileId: "file-1",
        mountPath: "files/file-1",
        filename: "input.txt",
        url: "https://storage.example/input.txt?sig=secret",
      },
    ]);

    await client.create!();
    await client.resume!({ manifest: new Manifest({ root: "/workspace" }) } as any);

    expect(sessions).toHaveLength(2);
  });

  test("keeps repository resources as git repo manifest entries", () => {
    const manifest = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://github.com/acme/app.git",
        ref: "main",
      },
    ]);
    expect(manifest.entries["repos/acme/app"]).toMatchObject({
      type: "git_repo",
      host: "github.com",
      repo: "acme/app",
      ref: "main",
    });
  });

  test("keeps GitHub App repository resources out of SDK git repo materialization", () => {
    const manifest = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://github.com/acme/private.git",
        ref: "main",
        githubInstallationId: 123,
        githubRepositoryId: 456,
      },
    ]);
    expect(manifest.entries["repos/acme/private"]).toMatchObject({ type: "dir" });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("git_repo");
    expect(serialized).not.toContain("githubInstallationId");
    expect(serialized).not.toContain("githubRepositoryId");
    expect(serialized).not.toContain("x-access-token");
  });

  test("keeps Modal repository resources out of SDK git repo materialization", () => {
    const manifest = buildManifest(testSettings({ sandboxBackend: "modal" }), [
      {
        kind: "repository",
        uri: "https://github.com/acme/private.git",
        ref: "main",
        githubInstallationId: 123,
        githubRepositoryId: 456,
      },
    ]);

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
    const modalManifest = buildManifest(testSettings({ sandboxBackend: "modal" }), [
      {
        kind: "repository",
        uri: "https://github.com/acme/private.git",
        ref: "main",
        githubInstallationId: 123,
        githubRepositoryId: 456,
      },
    ]);
    expect(modalManifest.extraPathGrants).toEqual([]);
    expect(buildManifest(testSettings(), []).extraPathGrants).toEqual([]);
  });

  test("clones repository resources inside the sandbox without embedding credentials", () => {
    const command = repositoryCloneCommand([
      {
        kind: "repository",
        uri: "https://github.com/acme/private.git",
        ref: "main",
        subpath: "packages/api",
        githubInstallationId: 123,
        githubRepositoryId: 456,
      },
    ]);

    expect(command).toContain(
      'git -C "$tmp" fetch --depth 1 --no-tags --filter=blob:none origin "$ref"',
    );
    expect(command).toContain('git -C "$target" rev-parse --is-inside-work-tree >/dev/null');
    expect(command).toContain("Repository resource ready at $target");
    expect(command).toContain("ensure_git");
    expect(command).toContain("apt-get install -y --no-install-recommends ca-certificates git");
    expect(command).toContain(
      "clone_repository '/workspace/repos/acme/private' 'https://github.com/acme/private.git' 'main' 'packages/api'",
    );
    expect(command).not.toContain("githubInstallationId");
    expect(command).not.toContain("githubRepositoryId");
    // TOKEN-BROKER (B2): the provisioned askpass script legitimately references the
    // "x-access-token" USERNAME constant (git's basic-auth username for an App token)
    // — that is not a credential. The credential guard is that no token VALUE and no
    // token-carrying env assignment ever rides the command text.
    expect(command).not.toContain("GITHUB_TOKEN=");
    expect(command).not.toContain("ghs_liveToken123");
  });

  test("TOKEN-BROKER (B1/B2): the clone command writes provider token FILES and provisions askpass + CLI wrappers before the clone", () => {
    const command = repositoryCloneCommand([
      {
        kind: "repository",
        uri: "https://github.com/acme/private.git",
        ref: "main",
        githubInstallationId: 123,
        githubRepositoryId: 456,
      },
    ]);

    // The seed writer reads only per-exec OPENGENI_GIT_*_TOKEN_SEED vars (never
    // manifest values) and writes STABLE token files ATOMICALLY: pid-suffixed temp
    // under umask 077, renamed into place.
    expect(command).toContain("umask 077");
    expect(command).toContain(
      'write_git_provider_token github "${OPENGENI_GIT_GITHUB_TOKEN_SEED:-${OPENGENI_GIT_TOKEN_SEED:-}}"',
    );
    expect(command).toContain(
      'write_git_provider_token gitlab "${OPENGENI_GIT_GITLAB_TOKEN_SEED:-}"',
    );
    expect(command).toContain(
      'write_git_provider_token azure_devops "${OPENGENI_GIT_AZURE_DEVOPS_TOKEN_SEED:-}"',
    );
    expect(command).toContain('printf \'%s\' "$token" > "$token_file.tmp.$$"');
    expect(command).toContain('mv -f "$token_file.tmp.$$" "$token_file"');
    expect(command).toContain(
      'mv -f "$credential_dir/github-token.tmp.$$" "$credential_dir/github-token"',
    );

    // TOKEN-BROKER (B2): the SAME setup block PROVISIONS the git-askpass helper at
    // SETUP (runtime) into the per-box, user-writable $GIT_ASKPASS (a manifest env
    // pointer, default $HOME/.opengeni/askpass), so auth is correct on ANY box image
    // without a baked script. Written via a QUOTED heredoc to a temp, chmod 0755,
    // then renamed into place (same atomicity as the token file).
    expect(command).toContain('git_askpass="${GIT_ASKPASS:-$HOME/.opengeni/askpass}"');
    expect(command).toContain("cat > \"$git_askpass.tmp.$$\" <<'ASKPASS_EOF'");
    expect(command).toContain('chmod 0755 "$git_askpass.tmp.$$"');
    expect(command).toContain('mv -f "$git_askpass.tmp.$$" "$git_askpass"');
    // The provisioned askpass' Password branch selects a provider by prompt host
    // and reads the corresponding token FILE.
    expect(command).toContain("*github.com*|*githubusercontent.com*) printf '%s\\n' github ;;");
    expect(command).toContain("*gitlab*) printf '%s\\n' gitlab ;;");
    expect(command).toContain(
      "*dev.azure.com*|*.visualstudio.com*) printf '%s\\n' azure_devops ;;",
    );
    expect(command).toContain(
      '*Password*) cat "$(token_file_for_provider "$provider")" 2>/dev/null || printf \'\\n\' ;;',
    );
    expect(command).toContain("github) printf '%s\\n' \"x-access-token\" ;;");

    // Provider CLI shims are installed early on PATH by the manifest env. They
    // read the CURRENT token file at invocation time and exec the real binary.
    expect(command).toContain('wrapper_dir="${OPENGENI_GIT_CLI_WRAPPER_DIR:-$HOME/.opengeni/bin}"');
    expect(command).toContain("for opengeni_git_cli_tool in gh glab az; do");
    expect(command).toContain("gh) provider=github; token_env=GH_TOKEN ;;");
    expect(command).toContain("glab) provider=gitlab; token_env=GITLAB_TOKEN ;;");
    expect(command).toContain("az) provider=azure_devops; token_env=AZURE_DEVOPS_EXT_PAT ;;");
    expect(command).toContain('GH_TOKEN) export GH_TOKEN="$token" ;;');
    expect(command).toContain('GITLAB_TOKEN) export GITLAB_TOKEN="$token" ;;');
    expect(command).toContain('AZURE_DEVOPS_EXT_PAT) export AZURE_DEVOPS_EXT_PAT="$token" ;;');

    // Helper writes MUST come BEFORE the fetch that consumes them (order matters:
    // GIT_ASKPASS execs the provisioned script, which reads the token file, during
    // the fetch).
    expect(command.indexOf("write_git_provider_token github")).toBeLessThan(
      command.indexOf('git -C "$tmp" fetch'),
    );
    expect(command.indexOf('cat > "$git_askpass.tmp.$$"')).toBeLessThan(
      command.indexOf('git -C "$tmp" fetch'),
    );
    expect(command.indexOf("cat > \"$wrapper.tmp.$$\" <<'CLI_WRAPPER_EOF'")).toBeLessThan(
      command.indexOf('git -C "$tmp" fetch'),
    );
    // The token VALUE is never literally in the command (only the env-var reference);
    // the "x-access-token" USERNAME constant is not a credential.
    expect(command).not.toContain("OPENGENI_GIT_TOKEN_SEED=");
  });

  test("never clones a repository onto a selfhosted (bring-your-own) machine", () => {
    const githubRepo = {
      kind: "repository" as const,
      uri: "https://github.com/acme/private.git",
      ref: "main",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    };
    const plainRepo = {
      kind: "repository" as const,
      uri: "https://github.com/acme/public.git",
      ref: "main",
    };

    // Cloud home backend: the clone fires today (modal always clones; any
    // backend clones a GitHub-App-connected repo). These are the unchanged
    // cloud paths.
    expect(repositoryUsesSandboxClone(testSettings({ sandboxBackend: "modal" }), githubRepo)).toBe(
      true,
    );
    expect(repositoryUsesSandboxClone(testSettings({ sandboxBackend: "modal" }), plainRepo)).toBe(
      true,
    );
    expect(repositoryUsesSandboxClone(testSettings({ sandboxBackend: "docker" }), githubRepo)).toBe(
      true,
    );
    expect(repositoryUsesSandboxClone(testSettings({ sandboxBackend: "docker" }), plainRepo)).toBe(
      false,
    );

    // Home backend IS selfhosted: gated with no caller change (active backend
    // defaults to the home backend).
    expect(
      repositoryUsesSandboxClone(testSettings({ sandboxBackend: "selfhosted" }), githubRepo),
    ).toBe(false);
    expect(
      repositoryUsesSandboxClone(testSettings({ sandboxBackend: "selfhosted" }), plainRepo),
    ).toBe(false);

    // Cloud home backend but ACTIVE sandbox swapped to a connected machine:
    // the explicit active-backend signal suppresses the clone even though the
    // home backend (modal/docker) would otherwise clone.
    expect(
      repositoryUsesSandboxClone(
        testSettings({ sandboxBackend: "modal" }),
        githubRepo,
        "selfhosted",
      ),
    ).toBe(false);
    expect(
      repositoryUsesSandboxClone(
        testSettings({ sandboxBackend: "docker" }),
        githubRepo,
        "selfhosted",
      ),
    ).toBe(false);

    // Active backend is another cloud box (a sibling Modal swap): still clones.
    expect(
      repositoryUsesSandboxClone(testSettings({ sandboxBackend: "modal" }), githubRepo, "modal"),
    ).toBe(true);
  });

  test("buildOpenGeniAgent accepts the activeSandboxBackend option for both cloud and selfhosted targets", () => {
    const resources = [
      {
        kind: "repository" as const,
        uri: "https://github.com/acme/private.git",
        ref: "main",
        githubInstallationId: 123,
        githubRepositoryId: 456,
      },
    ];
    // The gating itself is covered behaviourally by the predicate test above
    // (the per-agent clone-hook set is held in a private WeakMap). Here we only
    // guard that the new option is accepted on the SandboxAgent build path for a
    // cloud home backend whether or not the active backend is swapped.
    expect(() =>
      buildOpenGeniAgent(testSettings({ sandboxBackend: "modal" }), resources, {
        activeSandboxBackend: "selfhosted",
      }),
    ).not.toThrow();
    expect(() =>
      buildOpenGeniAgent(testSettings({ sandboxBackend: "modal" }), resources, {
        activeSandboxBackend: "modal",
      }),
    ).not.toThrow();
    expect(() =>
      buildOpenGeniAgent(testSettings({ sandboxBackend: "modal" }), resources),
    ).not.toThrow();
  });

  test("runs repository clone hook as a sandbox lifecycle hook", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    await runRepositoryCloneHook(
      {
        execCommand: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { status: 0, output: "" };
        },
      } as any,
      [
        {
          kind: "repository",
          uri: "https://github.com/acme/private.git",
          ref: "main",
          githubInstallationId: 123,
          githubRepositoryId: 456,
        },
      ],
      {
        environment: { GH_TOKEN: "secret-token" },
        runAs: "sandbox",
        onRuntimeEvent: (event) => {
          events.push(event.type);
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.runAs).toBe("sandbox");
    expect(calls[0]?.workdir).toBe("/workspace");
    expect(String(calls[0]?.cmd)).toContain("git init");
    expect(String(calls[0]?.cmd)).not.toContain("secret-token");
    expect(events).toEqual(["sandbox.operation.started", "sandbox.operation.completed"]);
  });

  test("TOKEN-BROKER (B1): the clone hook seeds the git token PER-EXEC (command prefix), never on the exec env/manifest", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runRepositoryCloneHook(
      {
        exec: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { output: "", stdout: "", stderr: "", wallTimeSeconds: 0, exitCode: 0 };
        },
      } as any,
      [
        {
          kind: "repository",
          uri: "https://github.com/acme/private.git",
          ref: "main",
          githubInstallationId: 123,
          githubRepositoryId: 456,
        },
      ],
      {
        environment: { HOME: "/workspace" },
        runAs: "sandbox",
        gitTokenSeed: "ghs_liveToken123",
      },
    );

    expect(calls).toHaveLength(1);
    // The seed is inlined as an ephemeral export PREFIX on the command text — it is
    // NOT passed as an exec `environment` option (ExecCommandArgs has no such field)
    // and NEVER lands on the box/agent manifest.
    expect(calls[0]?.environment).toBeUndefined();
    expect(String(calls[0]?.cmd)).toContain(
      "export OPENGENI_GIT_GITHUB_TOKEN_SEED='ghs_liveToken123'",
    );
    expect(String(calls[0]?.cmd)).toContain("export OPENGENI_GIT_TOKEN_SEED='ghs_liveToken123'");
    // The prefix precedes the seed writer that writes the file.
    expect(String(calls[0]?.cmd).indexOf("export OPENGENI_GIT_TOKEN_SEED=")).toBeLessThan(
      String(calls[0]?.cmd).indexOf("write_git_provider_token github"),
    );
    // TOKEN-BROKER (B2): the SAME per-exec command also provisions an EXECUTABLE git
    // askpass into $GIT_ASKPASS whose Password branch reads the token file — so a warm
    // box on ANY image gets a correct askpass at setup, no baked script required.
    const cmd = String(calls[0]?.cmd);
    expect(cmd).toContain("cat > \"$git_askpass.tmp.$$\" <<'ASKPASS_EOF'");
    expect(cmd).toContain('chmod 0755 "$git_askpass.tmp.$$"');
    expect(cmd).toContain('mv -f "$git_askpass.tmp.$$" "$git_askpass"');
    expect(cmd).toContain(
      '*Password*) cat "$(token_file_for_provider "$provider")" 2>/dev/null || printf \'\\n\' ;;',
    );
  });

  test("TOKEN-BROKER (B1): the clone hook seeds GitLab and Azure DevOps tokens per-exec", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runRepositoryCloneHook(
      {
        exec: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { output: "", stdout: "", stderr: "", wallTimeSeconds: 0, exitCode: 0 };
        },
      } as any,
      [
        {
          kind: "repository",
          uri: "https://gitlab.com/acme/private.git",
          ref: "main",
          provider: "gitlab",
          repositoryId: "gl-456",
        },
      ],
      {
        environment: { HOME: "/workspace" },
        gitTokenSeeds: {
          gitlab: "glpat_liveToken123",
          azure_devops: "azdo_liveToken456",
        },
      },
    );

    const cmd = String(calls[0]?.cmd);
    expect(calls[0]?.environment).toBeUndefined();
    expect(cmd).toContain("export OPENGENI_GIT_GITLAB_TOKEN_SEED='glpat_liveToken123'");
    expect(cmd).toContain("export OPENGENI_GIT_AZURE_DEVOPS_TOKEN_SEED='azdo_liveToken456'");
    expect(cmd).not.toContain("GITLAB_TOKEN='glpat_liveToken123'");
    expect(cmd).not.toContain("AZURE_DEVOPS_EXT_PAT='azdo_liveToken456'");
  });

  test("TOKEN-BROKER (B1): with NO seed the clone hook command is byte-for-byte the un-prefixed clone (no-op on selfhosted)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runRepositoryCloneHook(
      {
        exec: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { output: "", stdout: "", stderr: "", wallTimeSeconds: 0, exitCode: 0 };
        },
      } as any,
      [
        {
          kind: "repository",
          uri: "https://github.com/acme/private.git",
          ref: "main",
          githubInstallationId: 123,
          githubRepositoryId: 456,
        },
      ],
      {
        environment: { HOME: "/workspace" },
      },
    );

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.cmd)).not.toContain("export OPENGENI_GIT_TOKEN_SEED=");
    expect(String(calls[0]?.cmd).startsWith("set -eu")).toBe(true);
  });

  test("TOOLSPACE-BROKER: seed hook writes the delegated token file from a per-exec prefix only", async () => {
    const command = toolspaceTokenSeedCommand();
    expect(command).toContain('if [ -n "${OPENGENI_TOOLSPACE_TOKEN_SEED:-}" ]; then');
    expect(command).toContain("umask 077");
    expect(command).toContain(
      'token_file="${OPENGENI_TOOLSPACE_TOKEN_FILE:-$HOME/.opengeni/toolspace-token}"',
    );
    expect(command).toContain(
      'printf \'%s\' "$OPENGENI_TOOLSPACE_TOKEN_SEED" > "$token_file.tmp.$$"',
    );
    expect(command).toContain('mv -f "$token_file.tmp.$$" "$token_file"');

    const calls: Array<Record<string, unknown>> = [];
    await runToolspaceTokenSeedHook(
      {
        exec: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { output: "", stdout: "", stderr: "", wallTimeSeconds: 0, exitCode: 0 };
        },
      } as any,
      {
        environment: {
          HOME: "/workspace",
          OPENGENI_TOOLSPACE_TOKEN_FILE: "/workspace/.opengeni/toolspace-token",
        },
        runAs: "sandbox",
        toolspaceTokenSeed: "ogd_toolspace_live",
      } as any,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.environment).toBeUndefined();
    const cmd = String(calls[0]?.cmd);
    expect(cmd).toContain("export OPENGENI_TOOLSPACE_TOKEN_SEED='ogd_toolspace_live'");
    expect(cmd.indexOf("export OPENGENI_TOOLSPACE_TOKEN_SEED=")).toBeLessThan(
      cmd.indexOf("printf '%s' \"$OPENGENI_TOOLSPACE_TOKEN_SEED\""),
    );
  });

  test("fails repository clone hook when sandbox command is still running", async () => {
    const events: string[] = [];
    await expect(
      runRepositoryCloneHook(
        {
          execCommand: async () =>
            [
              "Chunk ID: abc123",
              "Wall time: 1.0000 seconds",
              "Process running with session ID 1",
              "Output:",
              "",
            ].join("\n"),
        } as any,
        [
          {
            kind: "repository",
            uri: "https://github.com/acme/private.git",
            ref: "main",
            githubInstallationId: 123,
            githubRepositoryId: 456,
          },
        ],
        {
          environment: { GH_TOKEN: "secret-token" },
          onRuntimeEvent: (event) => {
            events.push(event.type);
          },
        },
      ),
    ).rejects.toThrow("did not finish before the lifecycle command timeout");

    expect(events).toEqual(["sandbox.operation.started", "sandbox.operation.failed"]);
  });

  test("keeps repository subpaths as git repo manifest subpaths", () => {
    const manifest = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://github.com/acme/private.git",
        ref: "main",
        mountPath: "repos/acme/private/README.md",
        subpath: "README.md",
      },
    ]);
    expect(manifest.entries["repos/acme/private/README.md"]).toMatchObject({
      type: "git_repo",
      host: "github.com",
      repo: "acme/private",
      ref: "main",
      subpath: "README.md",
    });
  });

  test("applies only missing manifest entries to resumed sandbox sessions", async () => {
    const current = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://github.com/acme/one.git",
        ref: "main",
      },
    ]);
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
    await applyMissingManifestEntries(
      {
        state: { manifest: current },
        applyManifest: async (manifest: Manifest) => {
          applied.push(manifest);
        },
      } as any,
      target,
    );
    expect(applied).toHaveLength(1);
    expect(Object.keys(applied[0]!.entries)).toEqual(["repos/acme/two"]);
  });

  test("refreshes manifest environment on OWNED resumed sessions and reports drift as key names", async () => {
    // OWNED-resume refresh is a FEATURE (a workspace-env edit reaching a
    // long-lived owned local/docker box) — owned applyManifest merges env with
    // no guard. The drift EVENT is the durable trace; the provided-session
    // guard fix lives in pinProvidedSessionManifestEnvironment (tested below),
    // NOT here.
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
      environment: { GH_TOKEN: "new-token", NEW_KEY: "added" },
    });
    const applied: Manifest[] = [];
    const events: { type: string; payload: unknown }[] = [];
    const session = {
      state: { manifest: current },
      applyManifest: async (manifest: Manifest) => {
        applied.push(manifest);
      },
    };
    await applyMissingManifestEntries(session as any, target, {
      onRuntimeEvent: (event) => {
        events.push(event);
      },
    });
    // Env refresh applied (owned semantics preserved).
    expect(applied).toHaveLength(1);
    expect(Object.keys(applied[0]!.entries)).toEqual([]);
    expect(
      JSON.parse(JSON.stringify((session.state.manifest as Manifest).environment)),
    ).toMatchObject({
      GH_TOKEN: { value: "new-token" },
    });
    // Drift rides a durable event as key names only — values are secrets.
    expect(events).toEqual([
      {
        type: "sandbox.env.drift",
        payload: { added: ["NEW_KEY"], removed: [], changed: ["GH_TOKEN"] },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("token");
  });

  test("pins provided-session agent manifests to the live box environment", async () => {
    const agent = {
      defaultManifest: new Manifest({
        root: "/workspace",
        entries: {
          "repos/acme/one": { type: "git_repo", host: "github.com", repo: "acme/one", ref: "main" },
        },
        environment: { HOME: "/workspace", NEW_KEY: "fresh" },
      }),
    };
    const session = {
      state: {
        manifest: new Manifest({
          root: "/workspace",
          entries: {},
          environment: { HOME: "/workspace" },
        }),
      },
    };
    const events: { type: string; payload: unknown }[] = [];
    await pinProvidedSessionManifestEnvironment(agent as any, session as any, {
      onRuntimeEvent: (event) => {
        events.push(event);
      },
    });
    // The agent's manifest now declares the box's OWN env (byte-identical ->
    // the SDK's validateNoEnvironmentDelta sees no delta), entries preserved.
    expect(JSON.parse(JSON.stringify(agent.defaultManifest.environment))).toMatchObject({
      HOME: { value: "/workspace" },
    });
    expect(JSON.parse(JSON.stringify(agent.defaultManifest.environment))).not.toHaveProperty(
      "NEW_KEY",
    );
    expect(Object.keys(agent.defaultManifest.entries)).toEqual(["repos/acme/one"]);
    expect(events).toEqual([
      {
        type: "sandbox.env.drift",
        payload: { added: ["NEW_KEY"], removed: [], changed: [] },
      },
    ]);
  });

  test("provided-session env pin is a no-op without drift", async () => {
    const manifest = new Manifest({
      root: "/workspace",
      entries: {},
      environment: { HOME: "/workspace" },
    });
    const agent = { defaultManifest: manifest };
    const events: { type: string; payload: unknown }[] = [];
    await pinProvidedSessionManifestEnvironment(
      agent as any,
      {
        state: {
          manifest: new Manifest({
            root: "/workspace",
            entries: {},
            environment: { HOME: "/workspace" },
          }),
        },
      } as any,
      {
        onRuntimeEvent: (event) => {
          events.push(event);
        },
      },
    );
    expect(agent.defaultManifest).toBe(manifest);
    expect(events).toEqual([]);
  });

  test("normalizes serialized manifest state before applying missing entries", async () => {
    const current = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://github.com/acme/one.git",
        ref: "main",
      },
    ]);
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
    await applyMissingManifestEntries(
      {
        state: { manifest: JSON.parse(JSON.stringify(current)) },
        applyManifest: async (manifest: Manifest) => {
          expect(typeof manifest.mountTargetsForMaterialization).toBe("function");
          applied.push(manifest);
        },
      } as any,
      JSON.parse(JSON.stringify(target)),
    );
    expect(applied).toHaveLength(1);
    expect(Object.keys(applied[0]!.entries)).toEqual(["repos/acme/two"]);
  });

  test("deserializes persisted sandbox envelopes through the sandbox client", async () => {
    const manifestRecord = JSON.parse(JSON.stringify(new Manifest({ entries: {} })));
    let received: Record<string, unknown> | null = null;
    const restored = await deserializeSandboxSessionStateEnvelope(
      {
        backendId: "docker",
        deserializeSessionState: async (state: Record<string, unknown>) => {
          received = state;
          return {
            manifest: new Manifest(state.manifest as any),
            workspaceRootPath: "/tmp/workspace",
            workspaceReady: true,
          } as any;
        },
      } as any,
      {
        providerState: {
          workspaceRootPath: "/tmp/workspace",
        },
        manifest: manifestRecord,
        workspaceReady: true,
      },
    );
    expect(received?.manifest).toEqual(manifestRecord);
    expect(typeof restored?.manifest.mountTargetsForMaterialization).toBe("function");
  });

  test("fails when resumed sandbox sessions cannot apply missing manifest entries", async () => {
    const target = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://github.com/acme/two.git",
        ref: "main",
      },
    ]);
    await expect(
      applyMissingManifestEntries(
        {
          state: { manifest: new Manifest({ root: "/workspace" }) },
        } as any,
        target,
      ),
    ).rejects.toThrow("cannot apply new manifest entries");
  });

  test("uses materializeEntry fallback for resumed sandbox sessions without applyManifest", async () => {
    const target = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://github.com/acme/two.git",
        ref: "main",
      },
    ]);
    const materialized: string[] = [];
    await applyMissingManifestEntries(
      {
        state: { manifest: new Manifest({ root: "/workspace" }) },
        materializeEntry: async ({ path }: { path: string }) => {
          materialized.push(path);
        },
      } as any,
      target,
    );
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
    expect(prefixedMcpToolName("files", "files_get_download_url")).toBe(
      "files__files_get_download_url",
    );
  });

  test("connects to real Streamable HTTP MCP servers with prefixes and allowed tool filtering", async () => {
    const mcp = startTestMcpServer();
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "docs",
            name: "Document Search",
            url: mcp.url,
            allowedTools: ["search_documents"],
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "docs" }],
    );
    try {
      expect(prepared.mcpServers).toHaveLength(1);
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["docs__search_documents"]);

      const result = await prepared.mcpServers[0]!.callTool("docs__search_documents", {
        query: "network policy",
      });
      expect(JSON.stringify(result)).toContain("found document for network policy");
      expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "network policy" } }]);
      await expect(
        prepared.mcpServers[0]!.callTool("docs__fetch_document", { id: "doc-1" }),
      ).rejects.toThrow("not allowed");
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("sends the shared access key to first-party MCP servers", async () => {
    const accessKey = "local-mcp-access-key";
    const mcp = startTestMcpServer({ requiredHeaders: { "x-opengeni-access-key": accessKey } });
    const prepared = await prepareAgentTools(
      testSettings({
        authRequired: true,
        accessKey,
        opengeniMcpUrl: mcp.url,
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: mcp.url,
            allowedTools: ["search_documents"],
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "opengeni" }],
    );
    try {
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["opengeni__search_documents"]);
      const result = await prepared.mcpServers[0]!.callTool("opengeni__search_documents", {
        query: "auth",
      });
      expect(JSON.stringify(result)).toContain("found document for auth");
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("first-party MCP bearer is re-signed PER REQUEST so a turn outliving the 1h TTL never 401s", async () => {
    // The prod killer: the first-party delegated bearer is signed with a 1h TTL.
    // Baked once at connect (the old behavior), a turn/connection that runs past
    // 1h re-sends the stale bearer → the endpoint 401s → the REQUIRED first-party
    // server fails the whole turn. The fix re-signs the bearer on EVERY request,
    // so it is always fresh. This test validates the bearer server-side with the
    // REAL verifier and fast-forwards the clock past the TTL between requests.
    const delegationSecret = "test-delegation-secret"; // testSettings default
    const seenExps: number[] = [];
    const mcp = startTestMcpServer({
      validateAuthorization: async (authorization) => {
        if (!authorization?.startsWith("Bearer ")) {
          return false;
        }
        // verifyDelegatedAccessToken rejects exp < now (now reads the mocked
        // clock), exactly like the production first-party endpoint.
        const payload = await verifyDelegatedAccessToken(
          delegationSecret,
          authorization.slice("Bearer ".length),
        );
        if (!payload) {
          return false;
        }
        seenExps.push(payload.exp);
        return true;
      },
    });
    const realDateNow = Date.now;
    let nowMs = 1_700_000_000_000; // fixed base
    globalThis.Date.now = () => nowMs;
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          // A `{workspaceId}` template keeps the config first-party (isFirstParty
          // short-circuits on it) and resolves to the test server's /mcp path
          // (the token goes in a query param the server ignores), so the real
          // first-party auth wrapper is exercised without URL rewriting.
          mcpServers: [
            {
              id: "opengeni",
              name: "OpenGeni",
              url: `${mcp.url}?ws={workspaceId}`,
              cacheToolsList: false,
            },
          ],
        }),
        [{ kind: "mcp", id: "opengeni" }],
        {
          accountId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
        },
      );
      try {
        // T0: connect + first list — bearer minted with exp = T0 + 1h.
        const first = await prepared.mcpServers[0]!.listTools();
        expect(first.map((t) => t.name)).toContain("opengeni__search_documents");
        const expsAfterFirst = seenExps.length;
        // Fast-forward 2h — any bearer minted at connect is now expired.
        nowMs += 2 * 60 * 60 * 1000;
        // Re-list (the SDK's per-step re-fetch). Pre-fix this 401s on the stale
        // baked bearer and throws (required → turn dies); post-fix the wrapper
        // re-signs a fresh bearer and it succeeds.
        const second = await prepared.mcpServers[0]!.listTools();
        expect(second.map((t) => t.name)).toContain("opengeni__search_documents");
        // Proof of per-request re-signing: the later bearer's exp advanced with
        // the clock (a static baked bearer would have a constant exp).
        expect(seenExps.length).toBeGreaterThan(expsAfterFirst);
        expect(seenExps[seenExps.length - 1]!).toBeGreaterThan(seenExps[0]!);
      } finally {
        await prepared.close();
      }
    } finally {
      globalThis.Date.now = realDateNow;
      mcp.close();
    }
  });

  test("a genuinely-broken first-party bearer still fails loud (no masking, no retry loop)", async () => {
    // The dynamic refresh must NOT mask a real breakage: if the endpoint rejects
    // every bearer (e.g. a server-side secret mismatch), the required first-party
    // server must still fail the turn — we always send a fresh VALID-format token
    // and never retry, so a persistent 401 surfaces as a hard connect failure.
    const mcp = startTestMcpServer({ validateAuthorization: () => false });
    try {
      await expect(
        prepareAgentTools(
          testSettings({
            mcpServers: [
              {
                id: "opengeni",
                name: "OpenGeni",
                url: `${mcp.url}?ws={workspaceId}`,
                cacheToolsList: false,
              },
            ],
          }),
          [{ kind: "mcp", id: "opengeni" }],
          {
            accountId: "11111111-1111-4111-8111-111111111111",
            workspaceId: "22222222-2222-4222-8222-222222222222",
          },
        ),
      ).rejects.toThrow();
    } finally {
      mcp.close();
    }
  });

  test("sends configured credential headers to third-party MCP servers", async () => {
    const mcp = startTestMcpServer({ requiredHeaders: { "x-api-key": "capability-credential" } });
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "cap-secure",
            name: "Secure capability MCP",
            url: mcp.url,
            headers: { "x-api-key": "capability-credential" },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "cap-secure" }],
    );
    try {
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toContain("cap-secure__search_documents");
      const result = await prepared.mcpServers[0]!.callTool("cap-secure__search_documents", {
        query: "headers",
      });
      expect(JSON.stringify(result)).toContain("found document for headers");
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("sends broker-resolved connectionRef headers to third-party MCP servers", async () => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const mcp = startTestMcpServer({ requiredHeaders: { authorization: "Bearer broker-token" } });
    const resolved: ResolveConnectionCredentialInput[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "cap-broker",
            name: "Brokered capability MCP",
            url: mcp.url,
            connectionRef: {
              connectionId,
              providerDomain: "api.example.com",
              kind: "api_key",
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "cap-broker" }],
      {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        resolveCredential: async (input) => {
          resolved.push(input);
          return { status: "ok", connectionId, headers: { authorization: "Bearer broker-token" } };
        },
      },
    );
    try {
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toContain("cap-broker__search_documents");
      const result = await prepared.mcpServers[0]!.callTool("cap-broker__search_documents", {
        query: "broker",
      });
      expect(JSON.stringify(result)).toContain("found document for broker");
      expect(
        resolved.some(
          (input) =>
            input.connectionRef.connectionId === connectionId && input.serverId === "cap-broker",
        ),
      ).toBe(true);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("retries brokered MCP requests once after 401 with a forced credential refresh", async () => {
    const connectionId = "33333333-3333-4333-8333-333333333333";
    const mcp = startTestMcpServer({ requiredHeaders: { authorization: "Bearer fresh-token" } });
    const resolved: ResolveConnectionCredentialInput[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "cap-refresh",
            name: "Refreshable capability MCP",
            url: mcp.url,
            connectionRef: {
              connectionId,
              providerDomain: "api.example.com",
              kind: "api_key",
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "cap-refresh" }],
      {
        workspaceId: "44444444-4444-4444-8444-444444444444",
        resolveCredential: async (input): Promise<ResolveConnectionCredentialResult> => {
          resolved.push(input);
          return {
            status: "ok",
            connectionId,
            headers: {
              authorization: input.forceRefresh ? "Bearer fresh-token" : "Bearer stale-token",
            },
          };
        },
      },
    );
    try {
      const result = await prepared.mcpServers[0]!.callTool("cap-refresh__search_documents", {
        query: "refresh",
      });
      expect(JSON.stringify(result)).toContain("found document for refresh");
      expect(resolved.some((input) => input.forceRefresh === true)).toBe(true);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("turns brokered 403 responses into auth-needed MCP tool errors", async () => {
    const connectionId = "55555555-5555-4555-8555-555555555555";
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer scoped-token" },
      forbiddenTools: ["search_documents"],
      forbiddenAuthenticateHeader:
        'Bearer error="insufficient_scope", scope="documents:read documents:write"',
    });
    const authNeeded: unknown[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "cap-scoped",
            name: "Scoped capability MCP",
            url: mcp.url,
            connectionRef: {
              connectionId,
              providerDomain: "api.example.com",
              kind: "api_key",
              scopes: ["documents:read"],
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "cap-scoped" }],
      {
        workspaceId: "66666666-6666-4666-8666-666666666666",
        resolveCredential: async () => ({
          status: "ok",
          connectionId,
          headers: { authorization: "Bearer scoped-token" },
        }),
        onAuthNeeded: (payload) => {
          authNeeded.push(payload);
        },
      },
    );
    try {
      await prepared.mcpServers[0]!.listTools();
      const result = await prepared.mcpServers[0]!.callTool("cap-scoped__search_documents", {
        query: "scope",
      });
      expect(result).toMatchObject({ isError: true });
      expect(authNeeded).toContainEqual(
        expect.objectContaining({
          serverId: "cap-scoped",
          toolName: "search_documents",
          providerDomain: "api.example.com",
          connectionId,
          reason: "insufficient_scope",
          scopes: ["documents:read", "documents:write"],
        }),
      );
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("brokered 403 without insufficient_scope challenge degrades to a tool error, never auth-needed", async () => {
    const connectionId = "56565656-5656-4565-8565-565656565656";
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer scoped-token" },
      forbiddenTools: ["search_documents"],
    });
    const authNeeded: unknown[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "cap-forbidden",
            name: "Forbidden capability MCP",
            url: mcp.url,
            connectionRef: {
              connectionId,
              providerDomain: "api.example.com",
              kind: "api_key",
              scopes: ["documents:read"],
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "cap-forbidden" }],
      {
        workspaceId: "67676767-6767-4676-8676-676767676767",
        resolveCredential: async () => ({
          status: "ok",
          connectionId,
          headers: { authorization: "Bearer scoped-token" },
        }),
        onAuthNeeded: (payload) => {
          authNeeded.push(payload);
        },
      },
    );
    try {
      await prepared.mcpServers[0]!.listTools();
      // A 403 with no insufficient_scope challenge is NOT an auth-needed (no
      // connection link posted). The server is best-effort (connectionRef), so
      // invocation isolation degrades the tool-call failure to an isError result
      // the model sees rather than throwing out of the turn — and it must still
      // NOT be misclassified as an auth-needed.
      const result = await prepared.mcpServers[0]!.callTool("cap-forbidden__search_documents", {
        query: "scope",
      });
      expect(result).toMatchObject({ isError: true });
      expect(authNeeded).toEqual([]);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("returns MCP isError output when a connectionRef needs auth at tool-call time", async () => {
    const connectionId = "77777777-7777-4777-8777-777777777777";
    const mcp = startTestMcpServer();
    const authNeeded: unknown[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "cap-auth-needed",
            name: "Auth-needed capability MCP",
            url: mcp.url,
            connectionRef: {
              connectionId,
              providerDomain: "api.example.com",
              kind: "api_key",
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "cap-auth-needed" }],
      {
        workspaceId: "88888888-8888-4888-8888-888888888888",
        resolveCredential: async (input): Promise<ResolveConnectionCredentialResult> => {
          if (input.toolName) {
            return {
              status: "auth_needed",
              reason: "missing_connection",
              providerDomain: "api.example.com",
              connectionId,
              authorizationUrl: "https://api.example.com/oauth/start",
            };
          }
          return { status: "ok", connectionId, headers: { authorization: "Bearer list-token" } };
        },
        onAuthNeeded: (payload) => {
          authNeeded.push(payload);
        },
      },
    );
    try {
      await prepared.mcpServers[0]!.listTools();
      const result = await prepared.mcpServers[0]!.callTool("cap-auth-needed__search_documents", {
        query: "auth",
      });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("Authentication required");
      expect(mcp.calls).toEqual([]);
      expect(authNeeded).toContainEqual(
        expect.objectContaining({
          serverId: "cap-auth-needed",
          toolName: "search_documents",
          reason: "missing_connection",
          authorizationUrl: "https://api.example.com/oauth/start",
        }),
      );
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("skips brokered MCP servers at connect time when auth is missing and emits auth-needed", async () => {
    const authNeeded: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            {
              id: "cap-missing",
              name: "Missing auth capability MCP",
              url: "http://127.0.0.1:9/mcp",
              connectionRef: {
                providerDomain: "api.example.com",
                kind: "api_key",
                subjectScope: "workspace",
              },
              cacheToolsList: false,
            },
          ],
        }),
        [{ kind: "mcp", id: "cap-missing" }],
        {
          workspaceId: "99999999-9999-4999-8999-999999999999",
          resolveCredential: async () => ({
            status: "auth_needed",
            reason: "missing_connection",
            providerDomain: "api.example.com",
            authorizationUrl: "https://api.example.com/oauth/start",
          }),
          onAuthNeeded: (payload) => {
            authNeeded.push(payload);
          },
        },
      );
      try {
        expect(prepared.mcpServers).toHaveLength(0);
        expect(authNeeded).toContainEqual(
          expect.objectContaining({
            serverId: "cap-missing",
            reason: "missing_connection",
            providerDomain: "api.example.com",
            authorizationUrl: "https://api.example.com/oauth/start",
          }),
        );
      } finally {
        await prepared.close();
      }
    } finally {
      console.warn = originalWarn;
    }
  });

  test("connecting without the required credential headers fails", async () => {
    const mcp = startTestMcpServer({ requiredHeaders: { "x-api-key": "capability-credential" } });
    try {
      await expect(
        prepareAgentTools(
          testSettings({
            mcpServers: [
              {
                id: "cap-secure",
                name: "Secure capability MCP",
                url: mcp.url,
                cacheToolsList: false,
              },
            ],
          }),
          [{ kind: "mcp", id: "cap-secure" }],
        ),
      ).rejects.toThrow();
    } finally {
      mcp.close();
    }
  });

  test("codex_apps: injects the dynamic ChatGPT bearer + account-id from the codex ALS at connect", async () => {
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer tok-123", "chatgpt-account-id": "acct-9" },
    });
    const prepared = await codexRequestStorage.run(makeCodexContext(), () =>
      prepareAgentTools(testSettings({ mcpServers: [CODEX_APPS_ENTRY(mcp.url)] }), [
        { kind: "mcp", id: "codex_apps" },
      ]),
    );
    try {
      expect(prepared.mcpServers).toHaveLength(1);
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toContain("codex_apps__search_documents");
      const result = await prepared.mcpServers[0]!.callTool("codex_apps__search_documents", {
        query: "gmail",
      });
      expect(JSON.stringify(result)).toContain("found document for gmail");
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("codex_apps: emits X-OpenAI-Product-Sku only when configured", async () => {
    const withSku = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer tok-123", "X-OpenAI-Product-Sku": "plus" },
    });
    const preparedWith = await codexRequestStorage.run(makeCodexContext(), () =>
      prepareAgentTools(
        testSettings({ codexProductSku: "plus", mcpServers: [CODEX_APPS_ENTRY(withSku.url)] }),
        [{ kind: "mcp", id: "codex_apps" }],
      ),
    );
    try {
      expect(preparedWith.mcpServers).toHaveLength(1); // connected => SKU header accepted
    } finally {
      await preparedWith.close();
      withSku.close();
    }

    // With the SKU unset, a server that REQUIRES the header rejects the connect,
    // and the best-effort drop leaves codex_apps absent (no throw).
    const requiresSku = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer tok-123", "X-OpenAI-Product-Sku": "plus" },
    });
    const preparedWithout = await codexRequestStorage.run(makeCodexContext(), () =>
      prepareAgentTools(testSettings({ mcpServers: [CODEX_APPS_ENTRY(requiresSku.url)] }), [
        { kind: "mcp", id: "codex_apps" },
      ]),
    );
    try {
      expect(preparedWithout.mcpServers).toHaveLength(0); // header absent => connect rejected => dropped
    } finally {
      await preparedWithout.close();
      requiresSku.close();
    }
  });

  test("codex_apps: no ALS store => no auth => graceful best-effort drop (turn does not throw)", async () => {
    const mcp = startTestMcpServer({ requiredHeaders: { authorization: "Bearer tok-123" } });
    // No codexRequestStorage.run wrapper: the bearer cannot be resolved, the
    // server fails auth at connect, and because codex_apps is best-effort the
    // call resolves with codex_apps simply absent (contrast the strict
    // third-party test above, which throws).
    const prepared = await prepareAgentTools(
      testSettings({ mcpServers: [CODEX_APPS_ENTRY(mcp.url)] }),
      [{ kind: "mcp", id: "codex_apps" }],
    );
    try {
      expect(prepared.mcpServers).toHaveLength(0);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("codex_apps: getToken rejection (needs_relogin) => graceful best-effort drop", async () => {
    const mcp = startTestMcpServer({ requiredHeaders: { authorization: "Bearer tok-123" } });
    const prepared = await codexRequestStorage.run(
      makeCodexContext({ tokenError: new Error("needs_relogin") }),
      () =>
        prepareAgentTools(testSettings({ mcpServers: [CODEX_APPS_ENTRY(mcp.url)] }), [
          { kind: "mcp", id: "codex_apps" },
        ]),
    );
    try {
      expect(prepared.mcpServers).toHaveLength(0);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("codex_apps best-effort partition does NOT weaken strict guarantees for sibling servers", async () => {
    // A required (non-codex) server that fails auth must still throw even when a
    // codex_apps server rides alongside it in the same prepare call.
    const required = startTestMcpServer({
      requiredHeaders: { "x-api-key": "capability-credential" },
    });
    const apps = startTestMcpServer({ requiredHeaders: { authorization: "Bearer tok-123" } });
    try {
      await expect(
        codexRequestStorage.run(makeCodexContext(), () =>
          prepareAgentTools(
            testSettings({
              mcpServers: [
                {
                  id: "cap-secure",
                  name: "Secure capability MCP",
                  url: required.url,
                  cacheToolsList: false,
                }, // no headers => fails strict
                CODEX_APPS_ENTRY(apps.url),
              ],
            }),
            [
              { kind: "mcp", id: "cap-secure" },
              { kind: "mcp", id: "codex_apps" },
            ],
          ),
        ),
      ).rejects.toThrow();
    } finally {
      required.close();
      apps.close();
    }
  });

  test("optional ToolRef whose connect fails is skipped, not fatal", async () => {
    // Optional MCP refs cover both auto-attached capability MCPs and
    // client/pack-selected portable refs. If the server returns 401 at connect,
    // the failure must drop the server with a warning and let the turn proceed
    // instead of failing before the model runs. The config carries NO
    // credential header, so the required-header server 401s.
    const broken = startTestMcpServer({
      requiredHeaders: { "x-api-key": "capability-credential" },
    });
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            {
              id: "geni-notebook",
              name: "Geni Notebook",
              url: broken.url,
              cacheToolsList: false,
            },
          ],
        }),
        [{ kind: "mcp", id: "geni-notebook", optional: true }],
      );
      try {
        expect(prepared.mcpServers).toHaveLength(0); // 401 at connect => dropped, no throw
      } finally {
        await prepared.close();
      }
      // A warning names the skipped server so the drop is observable.
      const warned = warnings.some((args) =>
        args.some((arg) => typeof arg === "string" && arg.includes("geni-notebook")),
      );
      expect(warned).toBe(true);
    } finally {
      console.warn = originalWarn;
      broken.close();
    }
  });

  test("optional capability MCP drop does NOT take down a healthy sibling in the same turn", async () => {
    // A broken optional capability server rides alongside a working required
    // server: the required one must still connect and remain available while the
    // optional one is skipped.
    const broken = startTestMcpServer({
      requiredHeaders: { "x-api-key": "capability-credential" },
    });
    const healthy = startTestMcpServer();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            { id: "geni-notebook", name: "Geni Notebook", url: broken.url, cacheToolsList: false },
            { id: "docs", name: "Document Search", url: healthy.url, cacheToolsList: false },
          ],
        }),
        [
          { kind: "mcp", id: "geni-notebook", optional: true },
          { kind: "mcp", id: "docs" },
        ],
      );
      try {
        expect(prepared.mcpServers.map((server) => server.name)).toEqual(["docs"]);
        const tools = await prepared.mcpServers[0]!.listTools();
        expect(tools.map((tool) => tool.name)).toContain("docs__search_documents");
      } finally {
        await prepared.close();
      }
    } finally {
      console.warn = originalWarn;
      broken.close();
      healthy.close();
    }
  });

  test("explicitly-requested (non-optional) capability MCP whose connect fails still fails the turn", async () => {
    // The strict contract is unchanged: a tool the caller explicitly requested
    // (no `optional` flag) that cannot connect must fail the turn.
    const broken = startTestMcpServer({
      requiredHeaders: { "x-api-key": "capability-credential" },
    });
    try {
      await expect(
        prepareAgentTools(
          testSettings({
            mcpServers: [
              {
                id: "geni-notebook",
                name: "Geni Notebook",
                url: broken.url,
                cacheToolsList: false,
              },
            ],
          }),
          [{ kind: "mcp", id: "geni-notebook" }],
        ),
      ).rejects.toThrow();
    } finally {
      broken.close();
    }
  });

  test("best-effort server whose tools/list throws at RUN time does not fail an unrelated turn", async () => {
    // Regression for the prod incident where a session turn hard-failed with
    // "Streamable HTTP error: Error POSTing to endpoint: authentication required"
    // because an OPTIONAL connection-broker-backed MCP server had an expired
    // credential. The server connects fine (its `initialize` handshake resolves a
    // still-valid credential), so the connect-time best-effort isolation lets it
    // through — but the credential is gone by the time the SDK's run-time
    // getAllMcpTools calls tools/list, which throws OUTSIDE the connect guard. The
    // invariant: that best-effort server drops to zero tools (with its
    // tool.auth_needed preserved) while a healthy sibling's tools survive and the
    // turn proceeds. Pre-fix, getAllMcpTools rethrows and the whole turn dies.
    const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    // The broker resolves a valid credential during connect (initialize), then the
    // credential expires: any resolve AFTER connect returns auth_needed(expired),
    // exactly reproducing "valid at connect, gone at tools/list".
    let connected = false;
    const expired = startTestMcpServer();
    const healthy = startTestMcpServer();
    const authNeeded: unknown[] = [];
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            {
              id: "cap-expired",
              name: "Expired-credential capability MCP",
              url: expired.url,
              connectionRef: {
                connectionId,
                providerDomain: "api.integrations-example.com",
                kind: "oauth2",
                subjectScope: "workspace",
              },
              cacheToolsList: false,
            },
            { id: "docs", name: "Document Search", url: healthy.url, cacheToolsList: false },
          ],
        }),
        [
          { kind: "mcp", id: "cap-expired" },
          { kind: "mcp", id: "docs" },
        ],
        {
          workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          resolveCredential: async (): Promise<ResolveConnectionCredentialResult> =>
            connected
              ? {
                  status: "auth_needed",
                  reason: "expired",
                  providerDomain: "api.integrations-example.com",
                  connectionId,
                }
              : {
                  status: "ok",
                  connectionId,
                  headers: { authorization: "Bearer valid-at-connect" },
                },
          onAuthNeeded: (payload) => {
            authNeeded.push(payload);
          },
        },
      );
      // Connect succeeded for both servers; the credential expires only now.
      connected = true;
      try {
        // Both connected, so both are handed to the runner.
        expect(prepared.mcpServers.map((server) => server.name).sort()).toEqual([
          "cap-expired",
          "docs",
        ]);
        // Drive the exact code path the agent runner uses. Pre-fix this REJECTS
        // (the expired server's tools/list 401 throws out of getAllMcpTools).
        const tools = await getAllMcpTools({ mcpServers: prepared.mcpServers });
        const toolNames = tools.map((tool) => tool.name);
        // The healthy sibling's tools survive; the expired server contributes none.
        expect(toolNames).toContain("docs__search_documents");
        expect(toolNames.some((name) => name.startsWith("cap-expired__"))).toBe(false);
        // The actionable signal is NOT silenced by the degrade.
        expect(authNeeded).toContainEqual(
          expect.objectContaining({
            serverId: "cap-expired",
            reason: "expired",
            providerDomain: "api.integrations-example.com",
            connectionId,
          }),
        );
      } finally {
        await prepared.close();
      }
      // The drop is observable in the log as a structured warn carrying the
      // server id and the error class (failure-visibility doctrine).
      const warned = warnings.some((args) =>
        args.some(
          (arg) =>
            typeof arg === "object" &&
            arg !== null &&
            (arg as { serverId?: unknown }).serverId === "cap-expired" &&
            typeof (arg as { errorClass?: unknown }).errorClass === "string",
        ),
      );
      expect(warned).toBe(true);
    } finally {
      console.warn = originalWarn;
      expired.close();
      healthy.close();
    }
  });

  test("best-effort server whose tools/list throws a NON-auth error also degrades, not just auth", async () => {
    // Rider on the auth fix: the invariant is generic — an OPTIONAL server that is
    // unavailable for ANY reason (here a provider 500, no connectionRef, so no
    // auth machinery is involved at all) must never fail an unrelated turn. This
    // guards against the fix silently narrowing to auth-only. The degrade has NO
    // tool.auth_needed to lean on, so the structured warn is the only visibility.
    const brokenOptional = startTestMcpServer({ serverErrorForMethods: ["tools/list"] });
    const healthy = startTestMcpServer();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            {
              id: "flaky",
              name: "Flaky optional MCP",
              url: brokenOptional.url,
              cacheToolsList: false,
            },
            { id: "docs", name: "Document Search", url: healthy.url, cacheToolsList: false },
          ],
        }),
        [
          { kind: "mcp", id: "flaky", optional: true },
          { kind: "mcp", id: "docs" },
        ],
      );
      try {
        // The optional server connects (initialize is fine); only tools/list 500s.
        expect(prepared.mcpServers.map((server) => server.name).sort()).toEqual(["docs", "flaky"]);
        const tools = await getAllMcpTools({ mcpServers: prepared.mcpServers });
        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).toContain("docs__search_documents");
        expect(toolNames.some((name) => name.startsWith("flaky__"))).toBe(false);
      } finally {
        await prepared.close();
      }
      // The non-auth degrade is observable: server id + a real error class.
      const warned = warnings.some((args) =>
        args.some(
          (arg) =>
            typeof arg === "object" &&
            arg !== null &&
            (arg as { serverId?: unknown }).serverId === "flaky" &&
            typeof (arg as { errorClass?: unknown }).errorClass === "string",
        ),
      );
      expect(warned).toBe(true);
    } finally {
      console.warn = originalWarn;
      brokenOptional.close();
      healthy.close();
    }
  });

  test("REQUIRED server whose tools/list throws at RUN time still fails the turn", async () => {
    // The fail-loud default is unchanged for explicitly-requested servers (no
    // `optional` flag, no connectionRef => not best-effort): a run-time tools/list
    // failure must propagate. The server connects (its `initialize` handshake is
    // accepted) but rejects `tools/list` with a 401, so the throw surfaces from
    // getAllMcpTools exactly like the best-effort case — only here it is NOT
    // contained, because the caller depends on this server.
    const strict = startTestMcpServer({ unauthorizedForMethods: ["tools/list"] });
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            { id: "docs-strict", name: "Document Search", url: strict.url, cacheToolsList: false },
          ],
        }),
        [{ kind: "mcp", id: "docs-strict" }],
      );
      try {
        // Connect succeeded, so the server is handed to the runner.
        expect(prepared.mcpServers).toHaveLength(1);
        // The run-time tools/list 401 must propagate (fail-loud), not degrade.
        await expect(getAllMcpTools({ mcpServers: prepared.mcpServers })).rejects.toThrow();
      } finally {
        await prepared.close();
      }
    } finally {
      strict.close();
    }
  });

  test("best-effort tool INVOCATION auth failure returns a tool error, preserves auth_needed, sibling intact", async () => {
    // Bar (1): the model calls a best-effort server's tool and it needs auth. The
    // broker publishes tool.auth_needed and short-circuits the call to the JSON-RPC
    // auth-needed error, which callTool surfaces as an isError result (recoverable)
    // — the turn survives, the actionable signal is preserved, and a healthy
    // sibling's tools stay callable.
    const connectionId = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
    const capMcp = startTestMcpServer();
    const healthy = startTestMcpServer();
    const authNeeded: unknown[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "cap",
            name: "Capability MCP",
            url: capMcp.url,
            connectionRef: {
              connectionId,
              providerDomain: "api.integrations-example.com",
              kind: "oauth2",
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
          { id: "docs", name: "Docs", url: healthy.url, cacheToolsList: false },
        ],
      }),
      [
        { kind: "mcp", id: "cap" },
        { kind: "mcp", id: "docs" },
      ],
      {
        workspaceId: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2",
        // Valid for connect/list (no toolName), auth_needed at tool-call time.
        resolveCredential: async (input): Promise<ResolveConnectionCredentialResult> =>
          input.toolName
            ? {
                status: "auth_needed",
                reason: "expired",
                providerDomain: "api.integrations-example.com",
                connectionId,
                authorizationUrl: "https://api.integrations-example.com/oauth/start",
              }
            : { status: "ok", connectionId, headers: { authorization: "Bearer list-token" } },
        onAuthNeeded: (payload) => {
          authNeeded.push(payload);
        },
      },
    );
    try {
      const cap = prepared.mcpServers.find((s) => s.name === "cap")!;
      const docs = prepared.mcpServers.find((s) => s.name === "docs")!;
      await cap.listTools();
      const result = await cap.callTool("cap__search_documents", { query: "x" });
      expect(result).toMatchObject({ isError: true });
      expect(authNeeded).toContainEqual(
        expect.objectContaining({
          serverId: "cap",
          toolName: "search_documents",
          reason: "expired",
        }),
      );
      // The healthy sibling remains fully usable in the same turn.
      const ok = await docs.callTool("docs__search_documents", { query: "y" });
      expect(JSON.stringify(ok)).toContain("found document for y");
    } finally {
      await prepared.close();
      capMcp.close();
      healthy.close();
    }
  });

  test("best-effort tool INVOCATION raw 401 (not auth-needed) degrades to a loop-safe tool error", async () => {
    // The prod case: a best-effort server's tool call throws a raw transport 401
    // that never became the broker's JSON-RPC short-circuit (e.g. a codex_apps
    // bearer expired mid-turn). callTool must return a tool-error RESULT the model
    // sees — with LOOP-SAFE copy (do-not-retry) and only the safe error surface
    // (class + status), never the raw response body — rather than throw.
    const flaky = startTestMcpServer({ unauthorizedForMethods: ["tools/call"] });
    const healthy = startTestMcpServer();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            { id: "flaky", name: "Flaky", url: flaky.url, cacheToolsList: false },
            { id: "docs", name: "Docs", url: healthy.url, cacheToolsList: false },
          ],
        }),
        [
          { kind: "mcp", id: "flaky", optional: true },
          { kind: "mcp", id: "docs" },
        ],
      );
      try {
        const flakySrv = prepared.mcpServers.find((s) => s.name === "flaky")!;
        const docs = prepared.mcpServers.find((s) => s.name === "docs")!;
        await flakySrv.listTools(); // fine — only tools/call 401s
        const result = await flakySrv.callTool("flaky__search_documents", { query: "x" });
        expect(result).toMatchObject({ isError: true });
        const text = JSON.stringify(result);
        // Loop-safety: the copy must steer the model away from re-calling it.
        expect(text).toMatch(/do not retry/i);
        // Safe surface only: class (+ status), NEVER the raw 401 body.
        expect(text).toContain("StreamableHTTPError");
        expect(text).not.toContain("unauthorized");
        // Sibling unaffected.
        const ok = await docs.callTool("docs__search_documents", { query: "y" });
        expect(JSON.stringify(ok)).toContain("found document for y");
      } finally {
        await prepared.close();
      }
      // Structured warn carries the safe fields, and never the raw body.
      const warned = warnings.find((args) =>
        args.some(
          (a) =>
            typeof a === "object" &&
            a !== null &&
            (a as { serverId?: unknown }).serverId === "flaky",
        ),
      );
      expect(warned).toBeDefined();
      const payload = warned!.find((a) => typeof a === "object" && a !== null) as Record<
        string,
        unknown
      >;
      expect(payload).toMatchObject({
        serverId: "flaky",
        toolName: "search_documents",
        errorClass: "StreamableHTTPError",
        status: 401,
      });
      expect(JSON.stringify(payload)).not.toContain("unauthorized");
    } finally {
      console.warn = originalWarn;
      flaky.close();
      healthy.close();
    }
  });

  test("best-effort tool INVOCATION non-auth error (500) also degrades, not just auth", async () => {
    // Generality: an optional server that is simply down (provider 5xx, no auth
    // machinery) must degrade at invocation the same way.
    const flaky = startTestMcpServer({ serverErrorForMethods: ["tools/call"] });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [{ id: "flaky", name: "Flaky", url: flaky.url, cacheToolsList: false }],
        }),
        [{ kind: "mcp", id: "flaky", optional: true }],
      );
      try {
        const flakySrv = prepared.mcpServers[0]!;
        await flakySrv.listTools(); // fine — only tools/call 500s
        const result = await flakySrv.callTool("flaky__search_documents", { query: "x" });
        expect(result).toMatchObject({ isError: true });
        expect(JSON.stringify(result)).toMatch(/do not retry/i);
      } finally {
        await prepared.close();
      }
    } finally {
      console.warn = originalWarn;
      flaky.close();
    }
  });

  test("REQUIRED server tool INVOCATION failure still throws (fail-loud)", async () => {
    // The fail-loud default is unchanged for a required server (no optional flag,
    // no connectionRef): its tool-call failure must propagate, not degrade.
    const strict = startTestMcpServer({ serverErrorForMethods: ["tools/call"] });
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [{ id: "docs-strict", name: "Docs", url: strict.url, cacheToolsList: false }],
        }),
        [{ kind: "mcp", id: "docs-strict" }],
      );
      try {
        await prepared.mcpServers[0]!.listTools(); // fine — only tools/call 500s
        await expect(
          prepared.mcpServers[0]!.callTool("docs-strict__search_documents", { query: "x" }),
        ).rejects.toThrow();
      } finally {
        await prepared.close();
      }
    } finally {
      strict.close();
    }
  });

  test("RE-LIST: best-effort tools/list failure degrades on EVERY re-list, sibling survives (Path-2 lock)", async () => {
    // #379 fixed listTools degrade; this locks the fact that the SDK's per-step
    // RE-LIST (getAllMcpTools called again mid-turn on the SAME PrefixedMcpServer
    // instances) is covered too — the guard is on the instance method, so every
    // re-list degrades a best-effort failure while the sibling's tools survive.
    const flaky = startTestMcpServer({ unauthorizedForMethods: ["tools/list"] });
    const healthy = startTestMcpServer();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            { id: "flaky", name: "Flaky", url: flaky.url, cacheToolsList: false },
            { id: "docs", name: "Docs", url: healthy.url, cacheToolsList: false },
          ],
        }),
        [
          { kind: "mcp", id: "flaky", optional: true },
          { kind: "mcp", id: "docs" },
        ],
      );
      try {
        // Two successive resolutions model two model steps' re-lists.
        for (let i = 0; i < 2; i++) {
          const tools = await getAllMcpTools({ mcpServers: prepared.mcpServers });
          const names = tools.map((t) => t.name);
          expect(names).toContain("docs__search_documents");
          expect(names.some((n) => n.startsWith("flaky__"))).toBe(false);
        }
      } finally {
        await prepared.close();
      }
    } finally {
      console.warn = originalWarn;
      flaky.close();
      healthy.close();
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

    const settingsForAuthorization = (authorization: string) =>
      testSettings({
        mcpServers: [
          {
            id: "opengeni",
            name: opengeniDefault!.name,
            url: mcp.url,
            headers: { authorization },
            cacheToolsList: opengeniDefault!.cacheToolsList,
          },
        ],
      });

    const toolNamesFor = async (authorization: string): Promise<string[]> => {
      const prepared = await prepareAgentTools(settingsForAuthorization(authorization), [
        { kind: "mcp", id: "opengeni" },
      ]);
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
    await expect(
      prepareAgentTools(testSettings(), [{ kind: "mcp", id: "missing" }]),
    ).rejects.toThrow("Unknown MCP server id");
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
      {
        path: "SKILL.md",
        content:
          "---\nname: infra-ops\ndescription: Operate workspace infrastructure.\n---\n# Infra ops\n",
      },
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
    expect(sourceDir.children["infra-ops"].children.references.children["runbook.md"].content).toBe(
      "Runbook.",
    );
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    const names = index.map((entry) => entry.name);
    expect(names).toContain("checkov");
    expect(names).toContain("infra-ops");
    const infra = index.find((entry) => entry.name === "infra-ops");
    expect(infra?.description).toBe("Operate workspace infrastructure.");
    expect(infra?.path).toBe("infra-ops");
  });

  test("an explicit pack skill description wins over SKILL.md frontmatter", () => {
    const source = lazySkillSourceWithPackSkills([
      { ...infraSkill, description: "Explicit description." },
    ]);
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    expect(index.find((entry) => entry.name === "infra-ops")?.description).toBe(
      "Explicit description.",
    );
  });

  test("a pack skill shadows a bundled skill with the same name", () => {
    const source = lazySkillSourceWithPackSkills([
      {
        name: "checkov",
        files: [{ path: "SKILL.md", content: "---\ndescription: Pack-provided checkov.\n---\n" }],
      },
    ]);
    const sourceDir = source.source as { type: string; children: Record<string, any> };
    expect(sourceDir.children.checkov.type).toBe("dir");
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    const checkovEntries = index.filter((entry) => entry.name === "checkov");
    expect(checkovEntries).toHaveLength(1);
    expect(checkovEntries[0]?.description).toBe("Pack-provided checkov.");
  });

  test("rejects unsafe pack skill content instead of mounting it", () => {
    expect(() =>
      lazySkillSourceWithPackSkills([
        {
          name: "bad",
          files: [
            { path: "SKILL.md", content: "x" },
            { path: "../escape.md", content: "x" },
          ],
        },
      ]),
    ).toThrow("Invalid pack skill file path");
    expect(() =>
      lazySkillSourceWithPackSkills([
        {
          name: "no-entry",
          files: [{ path: "references/only.md", content: "x" }],
        },
      ]),
    ).toThrow("missing a top-level SKILL.md");
    expect(() =>
      lazySkillSourceWithPackSkills([
        { name: "dup", files: [{ path: "SKILL.md", content: "a" }] },
        { name: "dup", files: [{ path: "SKILL.md", content: "b" }] },
      ]),
    ).toThrow("Duplicate pack skill name");
    expect(() =>
      lazySkillSourceWithPackSkills([
        {
          name: "bad/name",
          files: [{ path: "SKILL.md", content: "x" }],
        },
      ]),
    ).toThrow("Invalid pack skill name");
  });

  test("buildOpenGeniAgent feeds pack skills through the SDK skills capability", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), [], {
      packSkills: [infraSkill],
    });
    const capabilities = (agent as any).capabilities as Array<{
      type: string;
      lazyFrom?: {
        source: { type: string };
        getIndex?: (manifest: unknown, skillsPath: string) => Array<{ name: string }>;
      };
    }>;
    const skillsCapability = capabilities.find((capability) => capability.type === "skills");
    expect(skillsCapability?.lazyFrom?.source.type).toBe("dir");
    const index = skillsCapability?.lazyFrom?.getIndex?.(emptyManifest, ".agents") ?? [];
    expect(index.map((entry) => entry.name)).toContain("infra-ops");
    // Backward compatibility: without pack skills the capability keeps the
    // plain bundled local-dir source.
    const plainAgent = buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), []);
    const plainCapability = (
      (plainAgent as any).capabilities as Array<{
        type: string;
        lazyFrom?: { source: { type: string } };
      }>
    ).find((capability) => capability.type === "skills");
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
    const message = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hi" }],
    } as any;
    const functionCall = {
      type: "function_call",
      id: "fc_1",
      callId: "call_abc",
      name: "exec_command",
      arguments: "{}",
      status: "completed",
    } as any;
    const functionOutput = {
      type: "function_call_result",
      id: "fco_1",
      callId: "call_abc",
      status: "completed",
      output: { type: "text", text: "ok" },
    } as any;
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

  test("callModelInputFilterForSettings preserves screenshot history prefixes across successive calls", async () => {
    const filter = callModelInputFilterForSettings(
      testSettings({
        openaiProvider: "openai",
        contextCompactionMode: "auto",
        contextWindowTokens: 100,
        contextReservedOutputTokens: 0,
      }),
    )!;
    const image = (n: number) =>
      `data:image/png;base64,${Buffer.from(`server-${n}`).toString("base64")}`;
    const prefix = [
      { type: "message", role: "user", content: "old" },
      { type: "function_call_result", callId: "a", output: image(1) },
      { type: "function_call_result", callId: "b", output: image(2) },
      { type: "function_call_result", callId: "c", output: image(3) },
      { type: "function_call_result", callId: "d", output: image(4) },
    ] as any;
    const first = await filter({
      modelData: { input: prefix },
      agent: {} as any,
      context: undefined,
    });
    const secondInput = [
      ...prefix,
      { type: "function_call_result", callId: "e", output: image(5) },
    ] as any;
    const second = await filter({
      modelData: { input: secondInput },
      agent: {} as any,
      context: undefined,
    });

    expect(first.input).toEqual(prefix);
    expect(second.input.slice(0, prefix.length)).toEqual(first.input);
    expect((second.input[1] as any).output).toBe(image(1));
    expect((second.input[4] as any).output).toBe(image(4));
    expect((second.input[5] as any).output).toBe(image(5));
  });

  test("callModelInputFilterForSettings applies budget trimming only in client mode", async () => {
    const clientFilter = callModelInputFilterForSettings(
      testSettings({
        openaiProvider: "azure",
        contextCompactionMode: "client",
        contextWindowTokens: 100,
        contextReservedOutputTokens: 0,
      }),
    )!;
    const serverFilter = callModelInputFilterForSettings(
      testSettings({
        openaiProvider: "openai",
        contextCompactionMode: "server",
        contextWindowTokens: 100,
        contextReservedOutputTokens: 0,
      }),
    )!;
    const input = [
      { type: "message", role: "user", content: "old turn" },
      { type: "message", role: "assistant", content: "x".repeat(1_000) },
      { type: "message", role: "user", content: "recent turn" },
      { type: "message", role: "assistant", content: "ok" },
    ] as any;

    const clientOut = await clientFilter({
      modelData: { input },
      agent: {} as any,
      context: undefined,
    });
    const serverOut = await serverFilter({
      modelData: { input },
      agent: {} as any,
      context: undefined,
    });

    expect(clientOut.input).toEqual(input.slice(2));
    expect(serverOut.input).toEqual(input);
  });

  test("buildOpenGeniAgent requests encrypted reasoning content unless disabled", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect((agent as any).modelSettings.providerData).toEqual({
      include: ["reasoning.encrypted_content"],
    });
    const disabled = buildOpenGeniAgent(
      testSettings({ sandboxBackend: "none", openaiReasoningEncryptedContent: false }),
      [],
    );
    expect((disabled as any).modelSettings.providerData).toBeUndefined();
  });
});
