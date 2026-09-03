import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
  RunContext,
  RunRawModelStreamEvent,
  RunState,
  getAllMcpTools,
  getLogger,
  invalidateServerToolsCache,
} from "@openai/agents";
import { RunToolApprovalItem, Usage } from "@openai/agents-core";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { IntegrationInvocationError } from "@opengeni/capabilities";
import {
  AGENT_INSTRUCTIONS_CORE_PLACEHOLDER,
  DEFAULT_AGENT_INSTRUCTIONS,
  getSettings,
} from "@opengeni/config";
import {
  CLEARED_RUN_STATE_BLOB,
  EDITABLE_ARTIFACT_MCP_CODEMODE_PATHS,
  INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME,
  MODEL_ATTACHMENT_REFS_FIELD,
  OPEN_SUFFIX_RUN_STATE_BLOB,
  sessionSystemUpdateBatchHistoryItem,
  type ToolAuthNeededPayload,
  verifyDelegatedAccessToken,
} from "@opengeni/contracts";
import {
  applyMissingManifestEntries,
  pinProvidedSessionManifestEnvironment,
  azureCliLoginCommand,
  azureOpenAIDefaultQuery,
  buildAgentCapabilities,
  buildOpenGeniAgent,
  HUMAN_INPUT_TOOL_NAME,
  buildManifest,
  compactMcpResultCustomDataRunState,
  composeAgentInstructions,
  ConnectorActionBindingRejectedError,
  ConnectorActionExecutionError,
  configureRuntimeMetricsHooks,
  connectMcpServersInBatches,
  coreInstructions,
  appendGitCredentialBindingInstructions,
  appendPersistentSessionSettings,
  appendSessionGoal,
  renderSessionGoalContext,
  appendCodemodeInstructions,
  appendWorkspaceMemory,
  CODEMODE_PROGRAMMATIC_DIRECTIVE,
  GENESIS_TITLE_DIRECTIVE,
  hasCanonicalEditableArtifactToolSurface,
  oneShotGenesisTitleInputFilter,
  composeRuntimeSkills,
  effectiveSkillSelectionsForAgent,
  listSkillLibraryEntries,
  loadSkillLibrarySkill,
  deserializeSandboxSessionStateEnvelope,
  ensureReadableStreamFrom,
  elideSupersededViewImagePairs,
  generateSessionTitle,
  materializeSandboxFileDownloads,
  repositoryCloneCommand,
  repositoryUsesSandboxClone,
  SESSION_TITLE_GENERATION_INPUT_MAX_CHARACTERS,
  SESSION_TITLE_GENERATION_INSTRUCTIONS,
  mcpToolErrorOutput,
  modelCallUsageTelemetry,
  normalizeModelCallUsage,
  modelResponseServiceTierFromSdkEvent,
  modelTerminalResponseFromSdkEvent,
  modelResponseUsageFromSdkEvent,
  modelResponseUsageFromResponse,
  normalizeSdkEvent,
  normalizeToolOutputForEvent,
  OPENGENI_INNER_MCP_CUSTOM_DATA_KEY,
  OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY,
  PrefixedMcpServer,
  prepareRunInput,
  runAgentStream,
  stripProviderItemIdsFilter,
  callModelInputFilterForSettings,
  contextRobustnessFilterForSettings,
  incrementalModelInputProjectionFilter,
  isMcpTransportConnectivityError,
  projectModelInputForCapabilities,
  projectModelInputForImageSupport,
  prefixedMcpToolName,
  prepareAgentTools,
  runAzureCliLoginHook,
  runBeforeAgentStartHooks,
  runRepositoryCloneHook,
  runCodemodeTokenSeedHook,
  mcpTransportErrorWithRetryMetadata,
  serializeApprovals,
  serializeHumanInputRequests,
  serializeInteractionInterventionRequests,
  refreshCodemodeTokenFile,
  refreshGitCredentialBindingTokenFiles,
  releaseMcpResultCustomDataFromSdkEvent,
  withStructuredViewImageFunctionResults,
  sandboxCommandExitCode,
  sandboxArtifactRuntimeDoctorHooks,
  sandboxFileDownloadsForAgent,
  sandboxLifecycleHooksForIds,
  sandboxRunAs,
  codemodeTokenSeedCommand,
  withSandboxFileDownloads,
  withSandboxSessionReady,
  withSandboxLifecycleHooks,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
  type ConnectorActionPolicyHooks,
  type RuntimeMetricsHooks,
} from "../src/index";
import { MCP_MAX_TOOL_RESULT_BYTES } from "../src/mcp-network";
import { baseModelInputFilterForSettings } from "../src/model-input";
import { OPENGENI_OPERATIONAL_INSTRUCTIONS } from "../src/operational-instructions";
import { McpResultCustomDataBridge } from "../src/mcp-result-custom-data";

import { Manifest } from "@openai/agents/sandbox";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { TurnSandboxCommandCancelledError } from "../src/sandbox/turn-tool-cancellation";
import { CompactionNeededError } from "../src/context-compaction";
import {
  buildPortableSkillArtifact,
  PORTABLE_SKILL_MAX_FILE_BYTES,
  readSkillLibraryArtifact,
  verifySkillLibraryArtifact,
} from "../src/skill-library";
import {
  MCP_MAX_CONCURRENT_SERVER_OPERATIONS,
  guardedMcpFetch,
  mcpTransportRequestFailureDiagnostic,
} from "../src/mcp-network";
import {
  ScriptedModel,
  functionCall as scriptedFunctionCall,
  startTestMcpServer,
  testSettings,
} from "@opengeni/testing";
import type { MCPServer } from "@openai/agents";
import {
  boundModelToolOutputItem,
  CODEX_APPS_MCP_URL,
  type CodexTokenSnapshot,
} from "@opengeni/codex";

function makeCodexAppsAuth(overrides: { token?: CodexTokenSnapshot; tokenError?: Error } = {}): {
  clientVersion: string;
  withAuthorization: <T>(use: (token: CodexTokenSnapshot) => Promise<T>) => Promise<T>;
} {
  const token: CodexTokenSnapshot = overrides.token ?? {
    accessToken: "tok-123",
    chatgptAccountId: "acct-9",
    isFedramp: false,
  };
  return {
    clientVersion: "0.0.0-test",
    withAuthorization: overrides.tokenError
      ? async () => {
          throw overrides.tokenError;
        }
      : async (use) => await use(token),
  };
}

const CODEX_APPS_ENTRY = () => ({
  id: "codex_apps",
  name: "codex_apps",
  url: CODEX_APPS_MCP_URL,
  cacheToolsList: false,
});

const codexAppsTestFetch =
  (url: string): typeof globalThis.fetch =>
  async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return await globalThis.fetch(raw === CODEX_APPS_MCP_URL ? url : input, init);
  };

const runtimeMcpServerId = (server: MCPServer): string =>
  server instanceof PrefixedMcpServer ? server.registryId : server.name;

test("Agents SDK debug logging omits model and tool payload data", () => {
  const logger = getLogger("opengeni:test-sensitive-logging");

  expect(process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA).toBe("1");
  expect(process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA).toBe("1");
  expect(logger.dontLogModelData).toBe(true);
  expect(logger.dontLogToolData).toBe(true);
});

test("forwards an explicit outer MCP connect timeout to the Agents SDK lifecycle", async () => {
  const slowServer = new PrefixedMcpServer(
    {
      name: "inner-slow-connect",
      cacheToolsList: false,
      connect: async () => {
        await Bun.sleep(50);
      },
      close: async () => {},
      listTools: async () => [],
      callTool: async () => [],
      invalidateToolsCache: async () => {},
    } as MCPServer,
    "slow-connect",
  );

  await expect(
    connectMcpServersInBatches([slowServer], {
      strict: true,
      connectTimeoutMs: 5,
    }),
  ).rejects.toThrow("MCP server connect timed out after 5ms");
});

test("preserves nested MCP connectivity diagnostics while adding a typed retry marker", () => {
  const raw = new Error("MCP connect failed for https://private.example/token-value");
  raw.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), {
    code: "ECONNREFUSED",
  });

  expect(isMcpTransportConnectivityError(raw)).toBe(false);
  const classified = mcpTransportErrorWithRetryMetadata(raw);

  expect(isMcpTransportConnectivityError(classified)).toBe(true);
  expect(classified).toBe(raw);
  expect(classified.message).toContain("private.example");
  expect(classified.cause).toMatchObject({
    message: "connect ECONNREFUSED 127.0.0.1:8000",
  });
});

test("does not turn MCP client failures or arbitrary codes into connectivity recovery", () => {
  const clientFailure = Object.assign(new Error("request rejected"), {
    status: 401,
    cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
  });
  const arbitrary = Object.assign(new Error("provider-specific failure"), {
    code: "CONNECTION_REFUSED_BY_POLICY",
  });

  expect(isMcpTransportConnectivityError(clientFailure)).toBe(false);
  expect(isMcpTransportConnectivityError(mcpTransportErrorWithRetryMetadata(clientFailure))).toBe(
    false,
  );
  expect(isMcpTransportConnectivityError(arbitrary)).toBe(false);
  expect(mcpTransportErrorWithRetryMetadata(arbitrary)).not.toHaveProperty(
    "mcpTransportFailureKind",
  );
});

test("fails closed on pathological MCP transport error wrappers", () => {
  let deeplyWrapped: Record<string, unknown> = { code: "ECONNREFUSED" };
  for (let depth = 0; depth < 10; depth += 1) {
    deeplyWrapped = { cause: deeplyWrapped };
  }
  const throwingWrapper = {
    code: "ECONNRESET",
    get cause(): unknown {
      throw new Error("unsafe transport getter");
    },
  };
  const throwingFields = {
    get code(): unknown {
      throw new Error("unsafe code getter");
    },
  };

  expect(isMcpTransportConnectivityError(mcpTransportErrorWithRetryMetadata(deeplyWrapped))).toBe(
    false,
  );
  expect(isMcpTransportConnectivityError(mcpTransportErrorWithRetryMetadata(throwingWrapper))).toBe(
    false,
  );
  expect(isMcpTransportConnectivityError(mcpTransportErrorWithRetryMetadata(throwingFields))).toBe(
    false,
  );
});

test("recovers only rollout-safe first-party MCP setup 404 and statusless Error shapes", () => {
  const routeNotReady = Object.assign(new Error("temporary route body with secret detail"), {
    status: 404,
  });
  const statuslessTransport = new Error("fetch failed for a secret first-party URL");
  const typedCause = Object.assign(new Error("wrapped protocol failure"), {
    cause: new TypeError("invalid MCP response shape"),
  });
  const authRejected = Object.assign(new Error("authentication failed"), {
    status: 401,
  });
  const typedProtocolFailure = new TypeError("invalid MCP response shape");

  expect(isMcpTransportConnectivityError(mcpTransportErrorWithRetryMetadata(routeNotReady))).toBe(
    false,
  );
  expect(
    isMcpTransportConnectivityError(
      mcpTransportErrorWithRetryMetadata(routeNotReady, {
        recoverySafeSetup: true,
      }),
    ),
  ).toBe(true);
  expect(
    isMcpTransportConnectivityError(
      mcpTransportErrorWithRetryMetadata(statuslessTransport, {
        recoverySafeSetup: true,
      }),
    ),
  ).toBe(true);
  expect(
    isMcpTransportConnectivityError(
      mcpTransportErrorWithRetryMetadata(typedCause, {
        recoverySafeSetup: true,
      }),
    ),
  ).toBe(false);
  expect(
    isMcpTransportConnectivityError(
      mcpTransportErrorWithRetryMetadata(authRejected, {
        recoverySafeSetup: true,
      }),
    ),
  ).toBe(false);
  expect(
    isMcpTransportConnectivityError(
      mcpTransportErrorWithRetryMetadata(typedProtocolFailure, {
        recoverySafeSetup: true,
      }),
    ),
  ).toBe(false);
  expect(
    mcpTransportErrorWithRetryMetadata(routeNotReady, {
      recoverySafeSetup: true,
    }),
  ).toBe(routeNotReady);
  expect(routeNotReady.message).toContain("secret detail");
});

describe("structured human-input runtime boundary", () => {
  const interruption = {
    name: HUMAN_INPUT_TOOL_NAME,
    rawItem: {
      callId: "human-call-1",
      name: HUMAN_INPUT_TOOL_NAME,
      arguments: JSON.stringify({
        questions: [
          {
            id: "choice",
            kind: "single_select",
            prompt: "Choose one",
            options: [{ id: "a", label: "A" }],
          },
        ],
        allowSkip: true,
        expiresInSeconds: 60,
      }),
    },
  };

  test("workspace policy omits only the human-input tool while enabled control preserves it", () => {
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: true,
    });
    const defaultTools = buildOpenGeniAgent(settings, []).tools.map((tool) => tool.name);
    const enabledTools = buildOpenGeniAgent(settings, [], {
      humanInputEnabled: true,
    }).tools.map((tool) => tool.name);
    const disabledTools = buildOpenGeniAgent(settings, [], {
      humanInputEnabled: false,
    }).tools.map((tool) => tool.name);

    expect(defaultTools).toContain(HUMAN_INPUT_TOOL_NAME);
    expect(enabledTools).toEqual(defaultTools);
    expect(disabledTools).not.toContain(HUMAN_INPUT_TOOL_NAME);
    expect(disabledTools).toEqual(defaultTools.filter((name) => name !== HUMAN_INPUT_TOOL_NAME));
  });

  test("partitions human requests out of ordinary approval payloads", () => {
    const ordinary = {
      name: "dangerous_tool",
      rawItem: {
        callId: "approval-1",
        name: "dangerous_tool",
        arguments: "{}",
      },
    };
    expect(serializeApprovals([interruption, ordinary])).toEqual([
      {
        id: "approval-1",
        name: "dangerous_tool",
        arguments: "{}",
        raw: ordinary,
      },
    ]);
    expect(serializeHumanInputRequests([ordinary, interruption])).toEqual([
      {
        toolCallId: "human-call-1",
        input: {
          questions: [
            {
              id: "choice",
              kind: "single_select",
              prompt: "Choose one",
              options: [{ id: "a", label: "A" }],
              required: true,
              allowOther: true,
            },
          ],
          allowSkip: true,
          expiresInSeconds: 60,
        },
      },
    ]);
  });

  test("partitions typed interaction waits while preserving their exact SDK approval", () => {
    const interaction = {
      name: INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME,
      rawItem: {
        callId: "interaction-human-call-1",
        name: INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME,
        arguments: JSON.stringify({
          operation: "wait",
          interventionId: "00000000-0000-4000-8000-000000000001",
        }),
      },
    };
    expect(serializeApprovals([interaction])).toEqual([]);
    expect(serializeInteractionInterventionRequests([interruption, interaction])).toEqual([
      {
        toolCallId: "interaction-human-call-1",
        input: {
          operation: "wait",
          interventionId: "00000000-0000-4000-8000-000000000001",
        },
        approval: {
          id: "interaction-human-call-1",
          name: INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME,
          arguments: JSON.stringify({
            operation: "wait",
            interventionId: "00000000-0000-4000-8000-000000000001",
          }),
          raw: interaction,
        },
      },
    ]);
  });

  test("normalizes SDK approval items before run-state and event persistence", () => {
    const rawItem = {
      type: "function_call",
      callId: "approval-undefined",
      name: "dangerous_tool",
      arguments: "{}",
      status: undefined,
      providerData: { traceId: "trace-approval", optional: undefined },
    };
    const approval = new RunToolApprovalItem(
      rawItem as any,
      { tools: [], toJSON: () => ({ name: "reviewer" }) } as any,
    );

    expect(serializeApprovals([approval])).toEqual([
      {
        type: "tool_approval_item",
        rawItem: {
          type: "function_call",
          callId: "approval-undefined",
          name: "dangerous_tool",
          arguments: "{}",
          providerData: { traceId: "trace-approval" },
        },
        agent: { name: "reviewer" },
        toolName: "dangerous_tool",
        functionToolStateKey: '["bare","dangerous_tool"]',
      },
    ]);
    expect(Object.hasOwn(rawItem, "status")).toBe(true);
    expect(Object.hasOwn(rawItem.providerData, "optional")).toBe(true);
  });

  test("the built-in tool always interrupts and only returns its injected durable response", async () => {
    const settings = testSettings({ sandboxBackend: "none" });
    const unresolvedAgent = buildOpenGeniAgent(settings, []);
    const unresolvedTool = unresolvedAgent.tools.find(
      (candidate) => candidate.type === "function" && candidate.name === HUMAN_INPUT_TOOL_NAME,
    );
    expect(unresolvedTool?.type).toBe("function");
    if (!unresolvedTool || unresolvedTool.type !== "function") throw new Error("tool missing");
    expect(unresolvedTool.needsApproval).toBeDefined();
    await expect(
      unresolvedTool.invoke(
        new RunContext(),
        JSON.stringify({
          questions: [{ id: "q", kind: "text", prompt: "Why?" }],
        }),
        {
          toolCall: {
            type: "function_call",
            callId: "human-call-1",
            name: HUMAN_INPUT_TOOL_NAME,
            arguments: "{}",
          },
        },
      ),
    ).rejects.toThrow(/without a durable response/i);

    const resumedAgent = buildOpenGeniAgent(settings, [], {
      humanInputResponse: {
        requestId: "00000000-0000-4000-8000-000000000001",
        toolCallId: "human-call-1",
        response: {
          outcome: "answered",
          answers: [{ questionId: "q", values: ["Because"] }],
        },
      },
    });
    const resumedTool = resumedAgent.tools.find(
      (candidate) => candidate.type === "function" && candidate.name === HUMAN_INPUT_TOOL_NAME,
    );
    if (!resumedTool || resumedTool.type !== "function") throw new Error("tool missing");
    expect(
      JSON.parse(
        String(
          await resumedTool.invoke(
            new RunContext(),
            JSON.stringify({
              questions: [{ id: "q", kind: "text", prompt: "Why?" }],
            }),
            {
              toolCall: {
                type: "function_call",
                callId: "human-call-1",
                name: HUMAN_INPUT_TOOL_NAME,
                arguments: "{}",
              },
            },
          ),
        ),
      ),
    ).toEqual({
      requestId: "00000000-0000-4000-8000-000000000001",
      outcome: "answered",
      answers: [{ questionId: "q", values: ["Because"] }],
    });
  });

  test("returns malformed human-input arguments to the model instead of interrupting the turn", async () => {
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });
    const validQuestions = [
      {
        id: "choice",
        kind: "single_select",
        prompt: "Choose one",
        options: [{ id: "a", label: "A" }],
      },
    ];
    const model = new ScriptedModel([
      {
        output: [
          scriptedFunctionCall(
            HUMAN_INPUT_TOOL_NAME,
            { questions: JSON.stringify(validQuestions), allowSkip: false },
            "human-call-invalid",
          ),
        ],
      },
      {
        output: [
          scriptedFunctionCall(
            HUMAN_INPUT_TOOL_NAME,
            { questions: validQuestions, allowSkip: false },
            "human-call-valid",
          ),
        ],
      },
    ]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
    });

    const result = await runAgentStream(agent, "Ask me to choose", settings);
    for await (const event of result.toStream()) void event;
    await result.completed;

    expect(model.calls).toBe(2);
    expect(result.interruptions).toHaveLength(1);
    expect(result.interruptions[0]?.rawItem).toMatchObject({
      callId: "human-call-valid",
      name: HUMAN_INPUT_TOOL_NAME,
    });
    expect(serializeHumanInputRequests(result.interruptions)).toEqual([
      {
        toolCallId: "human-call-valid",
        input: {
          questions: [
            {
              ...validQuestions[0],
              required: true,
              allowOther: true,
            },
          ],
          allowSkip: false,
        },
      },
    ]);
    const retryInput = JSON.stringify(model.requests[1]?.input);
    expect(retryInput).toContain("Tool execution failed. Error details are redacted.");
    expect(retryInput).toContain("human-call-invalid");
  });

  test("rejects malformed interruption arguments instead of exposing an unvalidated form", () => {
    expect(() =>
      serializeHumanInputRequests([
        {
          ...interruption,
          rawItem: { ...interruption.rawItem, arguments: "not-json" },
        },
      ]),
    ).toThrow(/invalid JSON/i);
  });

  test("rejects a human-input interruption without a stable tool-call identity", () => {
    expect(() =>
      serializeHumanInputRequests([
        {
          toolName: HUMAN_INPUT_TOOL_NAME,
          arguments: JSON.stringify({
            questions: [{ id: "q", kind: "text", prompt: "Why?" }],
          }),
        },
      ]),
    ).toThrow(/stable tool-call identity/i);
  });
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

  test("preserves the assistant message phase on completed events", () => {
    const [commentary] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        type: "message_output_item",
        text: "Waiting for the child run to finish.",
        rawItem: {
          role: "assistant",
          status: "completed",
          phase: "commentary",
          content: [{ type: "output_text", text: "Waiting for the child run to finish." }],
        },
      },
    } as any);
    const [finalAnswer] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        type: "message_output_item",
        text: "All checks passed.",
        rawItem: {
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "All checks passed." }],
        },
      },
    } as any);

    expect(commentary).toEqual({
      type: "agent.message.completed",
      payload: { text: "Waiting for the child run to finish.", phase: "commentary" },
    });
    expect(finalAnswer).toEqual({
      type: "agent.message.completed",
      payload: { text: "All checks passed.", phase: "final_answer" },
    });
  });

  test("extracts streamed usage without manufacturing a durable event", () => {
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
    expect(normalizeSdkEvent(event)).toEqual([]);
  });

  test("recognizes a terminal response when the provider omitted usage", () => {
    const event = {
      type: "raw_model_stream_event",
      data: {
        type: "response_done",
        response: { id: "resp-without-usage" },
      },
    } as any;

    expect(modelTerminalResponseFromSdkEvent(event)).toEqual({
      responseId: "resp-without-usage",
      usage: null,
    });
    expect(modelResponseUsageFromSdkEvent(event)).toBeNull();
  });

  test("extracts raw Responses usage without manufacturing a durable event", () => {
    const event = new RunRawModelStreamEvent({
      type: "model",
      providerData: {
        rawModelEventSource: OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
      },
      event: {
        type: "response.completed",
        response: {
          id: "resp-2",
          service_tier: "priority",
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
      serviceTier: "priority",
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
        inputTokensDetails: { cached_tokens: 4 },
        outputTokensDetails: { reasoning_tokens: 6 },
      },
    });
    expect(modelResponseServiceTierFromSdkEvent(event)).toEqual({
      source: "provider",
      serviceTier: "priority",
    });
    expect(normalizeSdkEvent(event)).toEqual([]);
  });

  test("extracts bounded Gateway route billing from raw and normalized responses", () => {
    const metadata = {
      gateway: {
        routing: { finalProvider: "novita" },
        inferenceCost: "0.00000325",
      },
    };
    const direct = modelResponseUsageFromResponse({
      id: "resp-gateway-raw",
      usage: {
        input_tokens: 405,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 331 },
      },
      provider_metadata: {
        gateway: {
          routing: { finalProvider: "novita" },
          cost: "0.00000325",
        },
      },
    });
    const normalized = modelResponseUsageFromResponse({
      id: "resp-gateway-normalized",
      usage: { inputTokens: 9, outputTokens: 8 },
      providerData: { provider_metadata: metadata },
    });

    expect(direct?.gatewayBilling).toEqual({
      finalProvider: "novita",
      inferenceCostUsd: "0.00000325",
    });
    expect(normalized?.gatewayBilling).toEqual(direct?.gatewayBilling);
    expect(direct?.usage).toMatchObject({
      inputTokens: 405,
      outputTokens: 4,
      inputTokensDetails: { cached_tokens: 331 },
    });
  });

  test("drops malformed Gateway billing metadata without dropping token usage", () => {
    const usage = modelResponseUsageFromResponse({
      id: "resp-gateway-invalid",
      usage: { input_tokens: 9, output_tokens: 8 },
      provider_metadata: {
        gateway: {
          routing: { finalProvider: "../../not-a-provider" },
          inferenceCost: "NaN",
        },
      },
    });

    expect(usage?.gatewayBilling).toBeUndefined();
    expect(usage?.usage).toMatchObject({ inputTokens: 9, outputTokens: 8 });
  });

  test("normalizes model-call usage telemetry fields and supported aliases", () => {
    expect(
      modelCallUsageTelemetry({
        inputTokens: 100,
        outputTokens: 20,
        inputTokensDetails: { cached_tokens: 80, cache_write_tokens: 12 },
        outputTokensDetails: { reasoning_tokens: 7 },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 80,
      cacheWriteTokens: 12,
      reasoningTokens: 7,
    });
    expect(
      modelCallUsageTelemetry({
        inputTokens: 50,
        outputTokens: 10,
        inputTokensDetails: { cached_input_tokens: 30, cacheWriteTokens: 9 },
      }),
    ).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cachedTokens: 30,
      cacheWriteTokens: 9,
      reasoningTokens: null,
    });
    // A wire `cached_tokens: 0` is REAL data (the provider cached nothing) and
    // must record as 0, not null — 10k+ genuinely-uncached Azure calls once
    // masqueraded as a telemetry gap because 0 was coerced to null. Absent
    // details still record null (unknown).
    expect(
      modelCallUsageTelemetry({
        inputTokens: 50,
        outputTokens: 10,
        inputTokensDetails: { cached_tokens: 0 },
        outputTokensDetails: { reasoning_tokens: 0 },
      }),
    ).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cachedTokens: 0,
      cacheWriteTokens: null,
      reasoningTokens: 0,
    });
    expect(modelCallUsageTelemetry({ inputTokens: 50, outputTokens: 10 })).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
    // Aggregate detail arrays represent individual requests and must be summed.
    expect(
      modelCallUsageTelemetry({
        inputTokensDetails: [
          { cached_tokens: 0, cache_write_tokens: 0 },
          { cached_tokens: 24, cacheWriteTokens: 6 },
        ],
      }),
    ).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: 24,
      cacheWriteTokens: 6,
      reasoningTokens: null,
    });
    expect(
      modelCallUsageTelemetry({
        inputTokensDetails: { cache_write_tokens: 0 },
      }),
    ).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      cacheWriteTokens: 0,
      reasoningTokens: null,
    });
  });

  test("sums installed SDK multi-request usage without double counting aliases", () => {
    const aggregate = new Usage();
    aggregate.add(
      new Usage({
        inputTokens: 1000,
        outputTokens: 10,
        totalTokens: 1010,
        inputTokensDetails: {
          cached_tokens: 100,
          cache_write_tokens: 200,
          cacheWriteTokens: 999,
        },
        outputTokensDetails: { reasoning_tokens: 5 },
      }),
    );
    aggregate.add(
      new Usage({
        inputTokens: 2000,
        outputTokens: 20,
        totalTokens: 2020,
        inputTokensDetails: { cached_tokens: 300, cacheWriteTokens: 400 },
        outputTokensDetails: { reasoning_tokens: 7 },
      }),
    );

    expect(normalizeModelCallUsage(aggregate)).toEqual({
      telemetry: {
        inputTokens: 3000,
        outputTokens: 30,
        cachedTokens: 400,
        cacheWriteTokens: 600,
        reasoningTokens: 12,
      },
      totalTokens: 3030,
      requestUsageEntries: [
        {
          inputTokens: 1000,
          outputTokens: 10,
          totalTokens: 1010,
          inputTokensDetails: { cached_tokens: 100, cache_write_tokens: 200 },
        },
        {
          inputTokens: 2000,
          outputTokens: 20,
          totalTokens: 2020,
          inputTokensDetails: { cached_tokens: 300, cache_write_tokens: 400 },
        },
      ],
      rejectedFields: [],
    });
  });

  test("prefers request details, falls back to aggregate arrays, and preserves unknowns", () => {
    expect(
      normalizeModelCallUsage({
        inputTokensDetails: [{ cached_tokens: 900, cache_write_tokens: 900 }],
        requestUsageEntries: [
          {
            inputTokensDetails: {
              cached_tokens: 10,
              cache_write_tokens: 20,
              cacheWriteTokens: 999,
            },
          },
          {
            inputTokensDetails: { cached_tokens: 30, cacheWriteTokens: 40 },
          },
        ],
      }).telemetry,
    ).toMatchObject({ cachedTokens: 40, cacheWriteTokens: 60 });

    expect(
      normalizeModelCallUsage({
        inputTokensDetails: [
          { cached_tokens: 100, cache_write_tokens: 200 },
          { cached_tokens: 300, cacheWriteTokens: 400 },
        ],
        outputTokensDetails: [{ reasoning_tokens: 5 }, { reasoningTokens: 7 }],
      }).telemetry,
    ).toMatchObject({
      cachedTokens: 400,
      cacheWriteTokens: 600,
      reasoningTokens: 12,
    });

    // If even one SDK request does not report a field, its aggregate total is
    // unknown rather than an undercount of only the requests that did report.
    expect(
      normalizeModelCallUsage({
        requestUsageEntries: [
          { inputTokensDetails: { cached_tokens: 0 } },
          { inputTokensDetails: {} },
        ],
      }).telemetry.cachedTokens,
    ).toBeNull();
    expect(
      normalizeModelCallUsage({
        requestUsageEntries: [{ inputTokensDetails: { cached_tokens: 10 } }, { inputTokens: 20 }],
      }).telemetry.cachedTokens,
    ).toBeNull();
    expect(normalizeModelCallUsage({ inputTokensDetails: { cached_tokens: 0 } }).telemetry).toEqual(
      {
        inputTokens: null,
        outputTokens: null,
        cachedTokens: 0,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    );
  });

  test("rejects malformed and overflowing usage with bounded field-only diagnostics", () => {
    const malformed = normalizeModelCallUsage({
      inputTokens: 1.5,
      outputTokens: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.POSITIVE_INFINITY,
      inputTokensDetails: {
        cached_tokens: -1,
        cache_write_tokens: 1_000_000_001,
      },
      outputTokensDetails: { reasoning_tokens: Number.NaN },
    });
    expect(malformed.telemetry).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
    expect(malformed.totalTokens).toBeNull();
    expect(malformed.rejectedFields).toEqual([
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "inputTokensDetails.cached_tokens",
      "inputTokensDetails.cache_write_tokens",
      "outputTokensDetails.reasoning_tokens",
    ]);
    expect(malformed.rejectedFields.join(" ")).not.toContain("Infinity");

    const overflow = normalizeModelCallUsage({
      inputTokens: 600_000_000,
      outputTokens: 600_000_000,
      inputTokensDetails: [{ cached_tokens: 600_000_000 }, { cached_tokens: 600_000_000 }],
    });
    expect(overflow.totalTokens).toBeNull();
    expect(overflow.telemetry.cachedTokens).toBeNull();
    expect(overflow.rejectedFields).toEqual(["totalTokens.aggregate", "cachedTokens.aggregate"]);

    const partialDetails = normalizeModelCallUsage({
      inputTokensDetails: [{ cached_tokens: 5 }, null as never, { cached_tokens: 7 }],
    });
    expect(partialDetails.telemetry.cachedTokens).toBeNull();
    expect(partialDetails.rejectedFields).toEqual(["inputTokensDetails[1]"]);
  });

  test("derives canonical totals and rejects low, high, and conflicting aggregate totals", () => {
    for (const reportedTotal of [0, 3, 119, 121, 999_999]) {
      const normalized = normalizeModelCallUsage({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: reportedTotal,
      });
      expect(normalized.totalTokens).toBe(120);
      expect(normalized.rejectedFields).toContain("totalTokens");
    }

    const conflictingAggregate = normalizeModelCallUsage({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      requestUsageEntries: [
        { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        { input_tokens: 200, output_tokens: 40, total_tokens: 240 },
      ],
    });
    expect(conflictingAggregate).toMatchObject({
      telemetry: { inputTokens: 300, outputTokens: 50 },
      totalTokens: 350,
    });
    expect(conflictingAggregate.rejectedFields).toEqual(
      expect.arrayContaining(["inputTokens", "outputTokens", "totalTokens"]),
    );

    const conflictingRequestTotals = normalizeModelCallUsage({
      inputTokens: 300,
      outputTokens: 50,
      totalTokens: 350,
      requestUsageEntries: [
        { inputTokens: 100, outputTokens: 10, totalTokens: 0 },
        { inputTokens: 200, outputTokens: 40, totalTokens: 3 },
      ],
    });
    expect(conflictingRequestTotals.totalTokens).toBe(350);
    expect(conflictingRequestTotals.rejectedFields).toEqual(
      expect.arrayContaining([
        "requestUsageEntries[0].totalTokens",
        "requestUsageEntries[1].totalTokens",
      ]),
    );
  });

  test("keeps canonical-total arithmetic bounded at cumulative overflow boundaries", () => {
    expect(
      normalizeModelCallUsage({
        inputTokens: 999_999_999,
        outputTokens: 1,
        totalTokens: 0,
      }),
    ).toMatchObject({ totalTokens: 1_000_000_000 });

    const derivedOverflow = normalizeModelCallUsage({
      inputTokens: 1_000_000_000,
      outputTokens: 1,
      totalTokens: 1,
    });
    expect(derivedOverflow.totalTokens).toBeNull();
    expect(derivedOverflow.rejectedFields).toEqual(
      expect.arrayContaining(["totalTokens.aggregate", "totalTokens"]),
    );

    const requestOverflow = normalizeModelCallUsage({
      inputTokens: 1,
      outputTokens: 0,
      totalTokens: 1,
      requestUsageEntries: [
        { inputTokens: 600_000_000, outputTokens: 0, totalTokens: 600_000_000 },
        { inputTokens: 400_000_001, outputTokens: 0, totalTokens: 400_000_001 },
      ],
    });
    expect(requestOverflow.telemetry.inputTokens).toBeNull();
    expect(requestOverflow.totalTokens).toBeNull();
    expect(requestOverflow.rejectedFields).toEqual(
      expect.arrayContaining([
        "inputTokens.requestUsageEntries",
        "totalTokens.requestUsageEntries",
        "inputTokens",
        "totalTokens",
      ]),
    );
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
      {
        type: "agent.reasoning.delta",
        payload: { text: "Checking credentials" },
      },
    ]);
  });

  test("maps live Responses web_search_call output items into tool events", () => {
    const [created] = normalizeSdkEvent(
      new RunRawModelStreamEvent({
        type: "model",
        providerData: {
          rawModelEventSource: OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
        },
        event: {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "web_search_call",
            id: "ws_live_1",
            status: "in_progress",
            action: { type: "search", query: "hexagonal diamond" },
          },
        },
      } as any),
    );

    expect(created).toEqual({
      type: "agent.toolCall.created",
      payload: {
        id: "ws_live_1",
        name: "web_search_call",
        arguments: { type: "search", query: "hexagonal diamond" },
        raw: {
          type: "hosted_tool_call",
          id: "ws_live_1",
          name: "web_search_call",
          status: "in_progress",
          providerData: {
            type: "web_search_call",
            id: "ws_live_1",
            action: { type: "search", query: "hexagonal diamond" },
          },
        },
      },
    });

    const [completed] = normalizeSdkEvent(
      new RunRawModelStreamEvent({
        type: "model",
        providerData: {
          rawModelEventSource: OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
        },
        event: {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "web_search_call",
            id: "ws_live_1",
            status: "completed",
            action: { type: "search", query: "hexagonal diamond" },
          },
        },
      } as any),
    );

    expect((completed?.payload as { raw?: { status?: string } } | undefined)?.raw?.status).toBe(
      "completed",
    );
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
    const rawItem = {
      callId: "call-1",
      type: "shell_call",
      action: { commands: ["terraform version"], optional: undefined },
      status: undefined,
    };
    const [event] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        id: "item-1",
        type: "tool_call_item",
        rawItem,
      },
    } as any);

    expect(event?.type).toBe("agent.toolCall.created");
    expect((event?.payload as { id?: string } | undefined)?.id).toBe("call-1");
    const raw = (event?.payload as { raw?: Record<string, unknown> } | undefined)?.raw;
    expect(Object.hasOwn(raw!, "status")).toBe(false);
    expect(Object.hasOwn(raw!.action as object, "optional")).toBe(false);
    expect(Object.hasOwn(rawItem, "status")).toBe(true);
    expect(Object.hasOwn(rawItem.action, "optional")).toBe(true);
  });

  test("keeps native tool-search call and output events on one provider identity", () => {
    const callId = "tool-search-provider-id";
    const [created] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        type: "tool_search_call_item",
        rawItem: {
          type: "tool_search_call",
          call_id: callId,
          callId: "conflicting-sdk-alias",
          arguments: { query: "matching tools" },
        },
      },
    } as any);
    const [completed] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        type: "tool_search_output_item",
        rawItem: {
          type: "tool_search_output",
          tools: [{ name: "matching_tool" }],
          providerData: { call_id: callId },
        },
      },
    } as any);

    expect(created).toMatchObject({
      type: "agent.toolCall.created",
      payload: { id: callId, name: "tool_search" },
    });
    expect(completed).toEqual({
      type: "agent.toolCall.output",
      payload: {
        id: callId,
        output: { type: "text", text: "Disclosed tools: matching_tool" },
      },
    });
  });

  test("normalizes tool outputs before durable event persistence", () => {
    const output = {
      type: "text",
      text: "done",
      structuredContent: undefined,
    };
    const [event] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        id: "item-output-1",
        type: "tool_call_output_item",
        rawItem: { callId: "call-output-1", type: "function_call_result" },
        output,
      },
    } as any);

    const persistedOutput = (event?.payload as { output?: Record<string, unknown> } | undefined)
      ?.output;
    expect(persistedOutput).toEqual({ type: "text", text: "done" });
    expect(Object.hasOwn(persistedOutput!, "structuredContent")).toBe(false);
    expect(Object.hasOwn(output, "structuredContent")).toBe(true);
  });

  test("prefers a validated complete MCP result marker while preserving explicit false", () => {
    const [event] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        id: "item-mcp-result",
        type: "tool_call_output_item",
        rawItem: { callId: "call-mcp-result", type: "function_call_result" },
        output: { type: "text", text: "model-visible content" },
        customData: {
          [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: {
            content: [{ type: "text", text: "model-visible content" }],
            structuredContent: { receiptId: "receipt-1" },
            isError: false,
            _meta: { providerTrace: "trace-1" },
          },
        },
      },
    } as any);

    expect(event?.type).toBe("agent.toolCall.output");
    expect((event!.payload as { output?: unknown }).output).toEqual({
      content: [{ type: "text", text: "model-visible content" }],
      structuredContent: { receiptId: "receipt-1" },
      isError: false,
      _meta: { providerTrace: "trace-1" },
    });
  });

  test("preserves explicit MCP errors and does not invent a missing outcome", () => {
    const events = [true, undefined].map((isError, index) => {
      const result = {
        content: [{ type: "text", text: `result-${index}` }],
        ...(isError === undefined ? {} : { isError }),
      };
      return normalizeSdkEvent({
        type: "run_item_stream_event",
        item: {
          id: `item-mcp-outcome-${index}`,
          type: "tool_call_output_item",
          rawItem: {
            callId: `call-mcp-outcome-${index}`,
            type: "function_call_result",
          },
          output: result.content[0],
          customData: { [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: result },
        },
      } as any)[0];
    });

    const failed = (events[0]!.payload as { output: Record<string, unknown> }).output;
    const unknown = (events[1]!.payload as { output: Record<string, unknown> }).output;
    expect(failed.isError).toBe(true);
    expect(Object.hasOwn(unknown, "isError")).toBe(false);
  });

  test("trusted tool output overrides take precedence over retained MCP custom data", () => {
    const override = { type: "generated_image", artifactId: "artifact-1" };
    const [event] = normalizeSdkEvent(
      {
        type: "run_item_stream_event",
        item: {
          id: "item-override",
          type: "tool_call_output_item",
          rawItem: { callId: "call-override", type: "function_call_result" },
          output: { type: "text", text: "model output" },
          customData: {
            [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: {
              content: [{ type: "text", text: "retained result" }],
              isError: false,
            },
          },
        },
      } as any,
      { toolOutputOverride: override },
    );

    expect((event!.payload as { output?: unknown }).output).toEqual(override);
  });

  test("ignores invalid MCP result markers and falls back to the SDK output", () => {
    const fallback = { type: "text", text: "sdk output" };
    const [event] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        id: "item-invalid-mcp-result",
        type: "tool_call_output_item",
        rawItem: {
          callId: "call-invalid-mcp-result",
          type: "function_call_result",
        },
        output: fallback,
        customData: {
          [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: {
            content: [{ type: "unsupported", value: "not MCP content" }],
          },
        },
      },
    } as any);

    expect((event!.payload as { output?: unknown }).output).toEqual(fallback);
  });

  test("compacts a codex computer_screenshot Uint8Array output to a non-retained media fact", () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const [event] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        id: "item-shot",
        type: "tool_call_output_item",
        rawItem: { callId: "call-shot", type: "function_call_result" },
        output: {
          type: "image",
          image: { data: pngBytes, mediaType: "image/png" },
        },
      },
    } as any);

    expect(event?.type).toBe("agent.toolCall.output");
    const payload = event?.payload as { id: string; output: unknown };
    expect(payload.id).toBe("call-shot");
    expect(payload.output).toMatchObject({
      type: "media_preview",
      mediaType: "image/png",
      inlineBytes: pngBytes.byteLength,
      fullOutputAvailable: false,
    });
    // No raw typed-array / object-of-numbers survives into the serialized event.
    expect(JSON.stringify(event)).not.toContain('"0":137');
    expect(JSON.stringify(event)).not.toContain("base64");
  });

  describe("normalizeToolOutputForEvent", () => {
    test("Uint8Array structured image → non-retained media fact", () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      expect(
        normalizeToolOutputForEvent({
          type: "image",
          image: { data: bytes, mediaType: "image/png" },
        }),
      ).toMatchObject({
        type: "media_preview",
        mediaType: "image/png",
        inlineBytes: 4,
        fullOutputAvailable: false,
      });
    });

    test("object-of-numbers (JSON-round-tripped Uint8Array) → media fact", () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const roundTripped = JSON.parse(
        JSON.stringify({
          type: "image",
          image: { data: bytes, mediaType: "image/jpeg" },
        }),
      );
      expect(normalizeToolOutputForEvent(roundTripped)).toMatchObject({
        type: "media_preview",
        mediaType: "image/jpeg",
        inlineBytes: 4,
      });
    });

    test("defaults media type to image/png when absent", () => {
      const bytes = new Uint8Array([1, 2, 3]);
      expect(normalizeToolOutputForEvent({ type: "image", image: { data: bytes } })).toMatchObject({
        type: "media_preview",
        mediaType: "image/png",
        inlineBytes: 3,
      });
    });

    test("base64 string / data-URL image data become byte-counted media facts", () => {
      expect(
        normalizeToolOutputForEvent({
          type: "image",
          image: { data: "aGk=", mediaType: "image/webp" },
        }),
      ).toMatchObject({
        type: "media_preview",
        mediaType: "image/webp",
        inlineBytes: 2,
      });
      expect(
        normalizeToolOutputForEvent({
          type: "image",
          image: { data: "data:image/png;base64,aGk=" },
        }),
      ).toMatchObject({
        type: "media_preview",
        mediaType: "image/png",
        inlineBytes: 2,
      });
    });

    test("already-normalized input_image content item → media fact", () => {
      expect(
        normalizeToolOutputForEvent({
          type: "input_image",
          image: "data:image/png;base64,aGk=",
        }),
      ).toMatchObject({
        type: "media_preview",
        mediaType: "image/png",
        inlineBytes: 2,
      });
    });

    test("a single-image array unwraps to the media fact", () => {
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
      expect(
        normalizeToolOutputForEvent([
          { type: "image", image: { data: bytes, mediaType: "image/gif" } },
        ]),
      ).toMatchObject({
        type: "media_preview",
        mediaType: "image/gif",
        inlineBytes: 4,
      });
    });

    test("text outputs pass through unchanged", () => {
      expect(normalizeToolOutputForEvent("plain tool output")).toBe("plain tool output");
    });

    test("hosted computer_call data-URL string output becomes a media fact", () => {
      const hosted = "data:image/png;base64,iVBORw0KGgo=";
      expect(normalizeToolOutputForEvent(hosted)).toMatchObject({
        type: "media_preview",
        mediaType: "image/png",
        inlineBytes: 8,
        fullOutputAvailable: false,
      });
    });

    test("mixed outputs retain text/error facts while replacing only inline media", () => {
      const mixed = normalizeToolOutputForEvent([
        { type: "text", text: "visible explanation" },
        { type: "input_image", image: "data:image/png;base64,aGk=" },
        { isError: true, text: "capture degraded" },
      ]);
      expect(mixed).toEqual([
        { type: "text", text: "visible explanation" },
        expect.objectContaining({ type: "media_preview", inlineBytes: 2 }),
        { isError: true, text: "capture degraded" },
      ]);
      expect(JSON.stringify(mixed)).not.toContain("base64");
    });

    test("MCP isError object output is unchanged", () => {
      const mcp = {
        isError: true,
        content: [{ type: "text", text: "delivery failed" }],
      };
      expect(normalizeToolOutputForEvent(mcp)).toEqual(mcp);
    });

    test("MCP result media blocks become content-free previews without losing result fields", () => {
      const normalized = normalizeToolOutputForEvent({
        content: [
          { type: "text", text: "capture" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "audio", data: "aGk=", mimeType: "audio/wav" },
          {
            type: "resource",
            resource: {
              uri: "file:///capture.bin",
              blob: "aGk=",
              mimeType: "application/octet-stream",
            },
          },
        ],
        structuredContent: { captureId: "capture-1" },
        isError: false,
        _meta: { providerTrace: "trace-1" },
      });
      expect(normalized).toEqual({
        content: [
          { type: "text", text: "capture" },
          expect.objectContaining({
            type: "media_preview",
            mediaType: "image/png",
            inlineBytes: 2,
          }),
          expect.objectContaining({
            type: "media_preview",
            mediaType: "audio/wav",
            inlineBytes: 2,
          }),
          expect.objectContaining({
            type: "media_preview",
            mediaType: "application/octet-stream",
            inlineBytes: 2,
          }),
        ],
        structuredContent: { captureId: "capture-1" },
        isError: false,
        _meta: { providerTrace: "trace-1" },
      });
      expect(JSON.stringify(normalized)).not.toContain("aGk=");
    });
  });

  test("codex view_image function results use structured image content, not tokenized data-URL text", async () => {
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const jpegBytes = Buffer.from(
      "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z",
      "base64",
    );
    const webpBytes = Buffer.from(
      "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
      "base64",
    );
    const dataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;
    const tool = {
      type: "function",
      name: "view_image",
      invoke: async () => dataUrl,
    } as any;
    const [wrapped] = withStructuredViewImageFunctionResults([tool]);
    expect(await (wrapped as any).invoke(undefined, "{}", undefined)).toEqual({
      type: "image",
      image: { url: dataUrl },
    });

    for (const [mediaType, bytes] of [
      ["image/jpeg", jpegBytes],
      ["image/jpg", jpegBytes],
      ["image/webp", webpBytes],
    ] as const) {
      const validDataUrl = `data:${mediaType};base64,${bytes.toString("base64")}`;
      const [wrappedValid] = withStructuredViewImageFunctionResults([
        { ...tool, invoke: async () => validDataUrl } as any,
      ]);
      expect(await (wrappedValid as any).invoke(undefined, "{}", undefined)).toEqual({
        type: "image",
        image: { url: validDataUrl },
      });
    }

    const errorTool = {
      ...tool,
      invoke: async () => "image path `/tmp/missing.png` was not found",
    } as any;
    const [wrappedError] = withStructuredViewImageFunctionResults([errorTool]);
    expect(await (wrappedError as any).invoke(undefined, "{}", undefined)).toBe(
      "image path `/tmp/missing.png` was not found",
    );

    for (const invalidDataUrl of [
      `data:image/bmp;base64,${Buffer.from("BM-invalid").toString("base64")}`,
      `data:image/png;base64,${Buffer.from("BM-mislabeled").toString("base64")}`,
      `data:image/png;base64,${jpegBytes.toString("base64")}`,
      `data:image/png;base64,${pngBytes.subarray(0, 8).toString("base64")}`,
      `data:image/png;base64,${Buffer.concat([pngBytes, Buffer.from("trailing")]).toString("base64")}`,
      `data:image/jpeg;base64,${jpegBytes.subarray(0, -2).toString("base64")}`,
      `data:image/webp;base64,${webpBytes.subarray(0, -1).toString("base64")}`,
      `data:image/webp;base64,${Buffer.from([0x52, 0x49, 0x46, 0x46, 0x16, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 0x0a, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0]).toString("base64")}`,
      "data:image/png;base64,AAAAA===",
    ]) {
      const [wrappedInvalid] = withStructuredViewImageFunctionResults([
        { ...tool, invoke: async () => invalidDataUrl } as any,
      ]);
      const result = await (wrappedInvalid as any).invoke(undefined, "{}", undefined);
      expect(result).toContain("Convert the file to PNG, JPEG, or WebP");
      expect(result).not.toContain("base64");
      if (invalidDataUrl.startsWith("data:image/png;base64,")) {
        expect(result).toContain("(image/png)");
      }
    }
  });

  test("view_image crosses the retention hook before returning to SDK history", async () => {
    const observed: unknown[] = [];
    const [filesystemCapability] = buildAgentCapabilities(testSettings(), [], {
      structuredToolTransport: false,
      supportsImageInput: true,
      onRetainableSessionImageOutput: async (input) => {
        observed.push(input);
      },
    });
    const bound = (filesystemCapability as any).bind({
      createEditor: () => ({}),
      viewImage: async () => ({
        type: "image",
        image: {
          data: Uint8Array.from(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
          ),
          mediaType: "image/png",
        },
      }),
    });
    const viewImage = bound.tools().find((tool: { name?: string }) => tool.name === "view_image");
    const output = await viewImage.invoke(undefined, '{"path":"/tmp/image.png"}', {
      toolCall: { callId: "call-view" },
    });
    expect(observed).toEqual([
      {
        toolName: "view_image",
        toolCallId: "call-view",
        output,
      },
    ]);
    expect(output).toMatchObject({
      type: "image",
      image: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    });
  });

  test("text-only models do not receive the filesystem view_image tool", () => {
    const toolNames = (supportsImageInput: boolean) => {
      const [filesystemCapability] = buildAgentCapabilities(testSettings(), [], {
        structuredToolTransport: false,
        supportsImageInput,
      });
      const bound = (filesystemCapability as any).bind({
        createEditor: () => ({}),
        viewImage: async () => ({ type: "image", image: { data: "aGk=" } }),
      });
      return bound.tools().map((tool: { name?: string }) => tool.name);
    };

    expect(toolNames(false)).toEqual(["apply_patch"]);
    expect(toolNames(true)).toEqual(["view_image", "apply_patch"]);
  });

  describe("failed MCP tool calls carry an isError flag", () => {
    test("mcpToolErrorOutput shapes a thrown error as an MCP isError result", () => {
      const out = mcpToolErrorOutput(new Error("MCP error -32602: Invalid params"));
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toContain("-32602");
      // Non-Error values stringify rather than throwing.
      expect(mcpToolErrorOutput("boom").content[0]?.text).toContain("boom");

      const hostileMessage = new Error("unreadable");
      Object.defineProperty(hostileMessage, "message", {
        configurable: true,
        get() {
          throw new Error("hostile message getter");
        },
      });
      expect(mcpToolErrorOutput(hostileMessage).content[0]?.text).toContain("MCP tool call failed");
    });

    test("mcpToolErrorOutput preserves credential-shaped error details exactly", () => {
      const bearer = "synthetic-bearer-value-123456";
      const cookie = ["synthetic", "cookie", "value", "123456"].join("-");
      const message = `upstream 401\nAuthorization: Bearer ${bearer}\nCookie: ${cookie}`;
      const out = mcpToolErrorOutput(new Error(message));
      const text = out.content[0]?.text ?? "";
      expect(text).toContain("upstream 401");
      expect(text).toContain(message);
      expect(text).toContain(bearer);
      expect(text).toContain(cookie);
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
        const produced = errorFunction!({
          context: {},
          error: new Error("boom"),
        });
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
      const payload = event?.payload as {
        id: string;
        output: { isError?: unknown };
      };
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
      expect(map).toEqual({
        docs__search_documents: true,
        docs__fetch_document: true,
      });
    });

    test("requireApproval: string[] → only the listed unprefixed tool needs approval", async () => {
      const map = await mcpToolApprovalMap(["fetch_document"]);
      expect(map).toEqual({
        docs__search_documents: false,
        docs__fetch_document: true,
      });
    });

    test("requireApproval absent → nothing needs approval (historical default)", async () => {
      const map = await mcpToolApprovalMap(undefined);
      expect(map).toEqual({
        docs__search_documents: false,
        docs__fetch_document: false,
      });
    });

    test("the canonical interaction wait always interrupts, including sandbox clones", async () => {
      const interactionServer: MCPServer = {
        name: "interaction",
        cacheToolsList: false,
        async connect() {},
        async close() {},
        async listTools() {
          return [
            {
              name: INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME,
              description: "Wait for exact human interaction",
              inputSchema: {
                type: "object" as const,
                properties: {},
                required: [],
                additionalProperties: true,
              },
            },
          ];
        },
        async callTool() {
          return [];
        },
        async invalidateToolsCache() {},
      };
      for (const backend of ["none", "modal"] as const) {
        const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: backend }), [], {
          mcpServers: [interactionServer],
        });
        expect(await approvalMapForAgent(agent)).toEqual({
          [INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME]: true,
        });
        const clone = (agent as unknown as { clone: (config: unknown) => ApprovalAgent }).clone({});
        expect(await approvalMapForAgent(clone)).toEqual({
          [INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME]: true,
        });
      }
    });

    test("only the exact SDK-approved interaction call can cross the attempt gateway", async () => {
      let executions = 0;
      const prepared = await prepareAgentTools(testSettings(), [], {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        attemptToolDefinitions: [
          {
            identity: { serverId: "interaction", toolName: "request_human" },
            modelName: INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME,
            inputSchema: { type: "object", additionalProperties: false },
            source: "interaction",
            approval: "human",
            execute: async () => {
              executions += 1;
              return { content: [{ type: "text", text: "resumed" }] };
            },
          },
        ],
      });
      const callId = "interaction-approved-call";
      try {
        await expect(
          prepared.attemptToolEnvironment!.callModel({
            modelName: INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME,
            arguments: {},
            subjectId: "worker:mcp-model",
          }),
        ).rejects.toMatchObject({ code: "approval_required" });
        expect(executions).toBe(0);

        const agent = buildOpenGeniAgent(testSettings(), [], {
          mcpServers: prepared.mcpServers,
          approvedToolCallId: callId,
        });
        const [tool] = (await agent.getMcpTools(new RunContext())).filter(
          (candidate) =>
            candidate.type === "function" &&
            candidate.name === INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME,
        );
        if (!tool || tool.type !== "function") throw new Error("interaction tool missing");
        await expect(
          tool.invoke(new RunContext(), JSON.stringify({}), {
            toolCall: { callId },
          } as any),
        ).resolves.toBeDefined();
        expect(executions).toBe(1);
        expect(
          await tool.invoke(new RunContext(), JSON.stringify({}), {
            toolCall: { callId: "interaction-unapproved-call" },
          } as any),
        ).toMatchObject({ isError: true });
        expect(executions).toBe(1);
      } finally {
        await prepared.close();
      }
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
        const agent = buildOpenGeniAgent(settings, [], {
          mcpServers: prepared.mcpServers,
        });
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

    async function connectorPolicyFixture(input: {
      connectorDecision: "allow" | "ask" | "block";
      legacyApproval?: boolean;
      begin?: ConnectorActionPolicyHooks["begin"];
      complete?: ConnectorActionPolicyHooks["complete"];
      sandboxBackend?: "none" | "modal";
    }) {
      const mcp = startTestMcpServer();
      const baseConfig = {
        id: "docs",
        name: "Document Search",
        url: mcp.url,
        cacheToolsList: false,
        ...(input.legacyApproval ? { requireApproval: true as const } : {}),
      };
      const calls: string[] = [];
      const hooks: ConnectorActionPolicyHooks = {
        prepare: async (call) => {
          calls.push(`prepare:${call.approvalId}:${String((call.arguments as any).query)}`);
          return { managed: true, decision: input.connectorDecision };
        },
        begin:
          input.begin ??
          (async (call) => {
            calls.push(`begin:${call.approvalId}:${String((call.arguments as any).query)}`);
            return input.connectorDecision === "block"
              ? {
                  allowed: false,
                  managed: true,
                  requestId: "request-1",
                  reason: "blocked",
                }
              : {
                  allowed: true,
                  managed: true,
                  requestId: "request-1",
                };
          }),
        complete:
          input.complete ??
          (async ({ requestId, outcome }) => {
            calls.push(`complete:${requestId}:${outcome}`);
          }),
      };
      const settings = testSettings({
        sandboxBackend: input.sandboxBackend ?? "none",
        mcpServers: [
          {
            ...baseConfig,
            connectionRef: {
              connectionId: "connection-1",
              providerDomain: "example.test",
            },
          },
        ],
      });
      const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "docs" }], {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        credentialSubjectId: "subject-a",
        resolveCredential: async () => ({
          status: "ok",
          connectionId: "connection-1",
          headers: { authorization: "Bearer connector-token" },
        }),
        connectorActionPolicy: hooks,
      });
      const agent = buildOpenGeniAgent(settings, [], {
        mcpServers: prepared.mcpServers,
        resolvedMcpConnectionIds: prepared.resolvedMcpConnectionIds,
        connectorActionPolicy: hooks,
      });
      return { agent, calls, mcp, prepared };
    }

    test("connector Allow executes once and preserves an existing Ask requirement", async () => {
      const fixture = await connectorPolicyFixture({
        connectorDecision: "allow",
        legacyApproval: true,
      });
      try {
        const [tool] = (await fixture.agent.getMcpTools(new RunContext())).filter(
          (candidate) =>
            candidate.type === "function" && candidate.name === "docs__search_documents",
        );
        if (!tool || tool.type !== "function") throw new Error("connector tool missing");
        expect(await tool.needsApproval(new RunContext(), { query: "needle" }, "call-allow")).toBe(
          true,
        );
        const output = await tool.invoke(new RunContext(), JSON.stringify({ query: "needle" }), {
          toolCall: { callId: "call-allow" },
        } as any);
        expect(output).toBeDefined();
        expect(fixture.mcp.calls).toEqual([
          { tool: "search_documents", args: { query: "needle" } },
        ]);
        expect(fixture.calls).toEqual([
          "prepare:call-allow:needle",
          "begin:call-allow:needle",
          "complete:request-1:completed",
        ]);
      } finally {
        await fixture.prepared.close();
        fixture.mcp.close();
      }
    });

    test("connector Ask pauses and Block/reject paths never invoke the provider", async () => {
      for (const connectorDecision of ["ask", "block"] as const) {
        const fixture = await connectorPolicyFixture({
          connectorDecision,
          begin: async () => ({
            allowed: false,
            managed: true,
            requestId: `request-${connectorDecision}`,
            reason: connectorDecision === "ask" ? "approval_required" : "blocked",
          }),
        });
        try {
          const [tool] = (await fixture.agent.getMcpTools(new RunContext())).filter(
            (candidate) =>
              candidate.type === "function" && candidate.name === "docs__search_documents",
          );
          if (!tool || tool.type !== "function") throw new Error("connector tool missing");
          expect(
            await tool.needsApproval(
              new RunContext(),
              { query: "top-secret-query" },
              `call-${connectorDecision}`,
            ),
          ).toBe(connectorDecision === "ask");
          expect(
            await tool.invoke(new RunContext(), JSON.stringify({ query: "top-secret-query" }), {
              toolCall: { callId: `call-${connectorDecision}` },
            } as any),
          ).toMatchObject({ isError: true });
          expect(fixture.mcp.calls).toHaveLength(0);
        } finally {
          await fixture.prepared.close();
          fixture.mcp.close();
        }
      }
    });

    test("connector execution retry is denied and the clone path retains enforcement", async () => {
      let begins = 0;
      const fixture = await connectorPolicyFixture({
        connectorDecision: "allow",
        sandboxBackend: "modal",
        begin: async () => {
          begins += 1;
          return begins === 1
            ? { allowed: true, managed: true, requestId: "request-retry" }
            : {
                allowed: false,
                managed: true,
                requestId: "request-retry",
                reason: "already_executed",
              };
        },
      });
      try {
        const clone = (
          fixture.agent as unknown as {
            clone: (config: unknown) => ApprovalAgent;
          }
        ).clone({});
        const [tool] = (await clone.getMcpTools(new RunContext())).filter(
          (candidate) =>
            candidate.type === "function" && candidate.name === "docs__search_documents",
        );
        if (!tool || tool.type !== "function") throw new Error("connector tool missing");
        const details = { toolCall: { callId: "call-retry" } } as any;
        await tool.invoke(new RunContext(), JSON.stringify({ query: "once" }), details);
        expect(
          await tool.invoke(new RunContext(), JSON.stringify({ query: "once" }), details),
        ).toMatchObject({ isError: true });
        expect(fixture.mcp.calls).toHaveLength(1);
      } finally {
        await fixture.prepared.close();
        fixture.mcp.close();
      }
    });

    test("attempt-local connector binding applies durable policy by exact model name", async () => {
      const executions: Record<string, unknown>[] = [];
      const calls: string[] = [];
      const hooks: ConnectorActionPolicyHooks = {
        prepare: async (call) => {
          calls.push(`prepare:${call.approvalId}:${String((call.arguments as any).title)}`);
          return { managed: true, decision: "ask" };
        },
        begin: async (call) => {
          calls.push(`begin:${call.approvalId}:${String((call.arguments as any).title)}`);
          return { allowed: true, managed: true, requestId: "request-drive" };
        },
        complete: async ({ requestId, outcome }) => {
          calls.push(`complete:${requestId}:${outcome}`);
        },
      };
      const bindings = [
        {
          modelName: "drive_publish",
          call: (approvalId: string, arguments_: unknown) => ({
            approvalId,
            connectionId: "connection-drive",
            serverId: "drive",
            toolName: "publish",
            arguments: arguments_,
          }),
        },
      ];
      const prepared = await prepareAgentTools(testSettings(), [], {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        connectorActionPolicy: hooks,
        attemptConnectorActionBindings: bindings,
        attemptToolDefinitions: [
          {
            identity: { serverId: "drive", toolName: "publish" },
            modelName: "drive_publish",
            inputSchema: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
              additionalProperties: false,
            },
            source: "mcp",
            approval: "policy",
            execute: async (args) => {
              executions.push(args);
              return { content: [{ type: "text", text: "published" }] };
            },
          },
        ],
      });
      const agent = buildOpenGeniAgent(testSettings(), [], {
        mcpServers: prepared.mcpServers,
        connectorActionPolicy: hooks,
        attemptConnectorActionBindings: bindings,
      });
      try {
        const [tool] = (await agent.getMcpTools(new RunContext())).filter(
          (candidate) => candidate.type === "function" && candidate.name === "drive_publish",
        );
        if (!tool || tool.type !== "function") throw new Error("attempt connector tool missing");
        expect(
          await tool.needsApproval(new RunContext(), { title: "Quarterly" }, "call-drive"),
        ).toBe(true);
        expect(
          await tool.invoke(new RunContext(), JSON.stringify({ title: "Quarterly" }), {
            toolCall: { callId: "call-drive" },
          } as any),
        ).toBeDefined();
        expect(executions).toEqual([{ title: "Quarterly" }]);
        expect(calls).toEqual([
          "prepare:call-drive:Quarterly",
          "begin:call-drive:Quarterly",
          "complete:request-drive:completed",
        ]);

        const resumedAgent = buildOpenGeniAgent(testSettings(), [], {
          mcpServers: prepared.mcpServers,
          connectorActionPolicy: hooks,
          attemptConnectorActionBindings: bindings,
          approvedToolCallId: "call-drive-resumed",
        });
        const [resumedTool] = (await resumedAgent.getMcpTools(new RunContext())).filter(
          (candidate) => candidate.type === "function" && candidate.name === "drive_publish",
        );
        if (!resumedTool || resumedTool.type !== "function") {
          throw new Error("resumed attempt connector tool missing");
        }
        expect(
          await resumedTool.invoke(new RunContext(), JSON.stringify({ title: "Resumed" }), {
            toolCall: { callId: "call-drive-resumed" },
          } as any),
        ).toBeDefined();
        expect(
          await resumedTool.invoke(new RunContext(), JSON.stringify({ title: "Wrong call" }), {
            toolCall: { callId: "call-drive-other" },
          } as any),
        ).toMatchObject({ isError: true });
        expect(executions).toEqual([{ title: "Quarterly" }, { title: "Resumed" }]);
        expect(calls.slice(-4)).toEqual([
          "prepare:call-drive-resumed:Resumed",
          "begin:call-drive-resumed:Resumed",
          "complete:request-drive:completed",
          "prepare:call-drive-other:Wrong call",
        ]);
      } finally {
        await prepared.close();
      }
    });

    test("attempt-local connector binding rejection becomes a tool error", async () => {
      const executions: Record<string, unknown>[] = [];
      const policyCalls: string[] = [];
      const hooks: ConnectorActionPolicyHooks = {
        prepare: async () => {
          policyCalls.push("prepare");
          return { managed: false, decision: "unmanaged" };
        },
        begin: async () => {
          policyCalls.push("begin");
          return { allowed: true, managed: false };
        },
        complete: async () => {
          policyCalls.push("complete");
        },
      };
      const bindings = [
        {
          modelName: "github_app__repository_get",
          call: () => {
            throw new ConnectorActionBindingRejectedError(
              "repository is outside accepted resources",
            );
          },
        },
      ];
      const prepared = await prepareAgentTools(testSettings(), [], {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        connectorActionPolicy: hooks,
        attemptConnectorActionBindings: bindings,
        attemptToolDefinitions: [
          {
            identity: { serverId: "github_app", toolName: "repository_get" },
            modelName: "github_app__repository_get",
            inputSchema: {
              type: "object",
              properties: { repository: { type: "string" } },
              required: ["repository"],
              additionalProperties: false,
            },
            source: "mcp",
            approval: "policy",
            execute: async (args) => {
              executions.push(args);
              return { content: [{ type: "text", text: "repository" }] };
            },
          },
        ],
      });
      const agent = buildOpenGeniAgent(testSettings(), [], {
        mcpServers: prepared.mcpServers,
        connectorActionPolicy: hooks,
        attemptConnectorActionBindings: bindings,
      });
      try {
        const [tool] = (await agent.getMcpTools(new RunContext())).filter(
          (candidate) =>
            candidate.type === "function" && candidate.name === "github_app__repository_get",
        );
        if (!tool || tool.type !== "function") throw new Error("attempt connector tool missing");
        expect(
          await tool.needsApproval(
            new RunContext(),
            { repository: "Cloudgeni-ai/not-accepted" },
            "call-rejected",
          ),
        ).toBe(false);
        expect(
          await tool.invoke(
            new RunContext(),
            JSON.stringify({ repository: "Cloudgeni-ai/not-accepted" }),
            { toolCall: { callId: "call-rejected" } } as any,
          ),
        ).toMatchObject({ isError: true });
        expect(executions).toEqual([]);
        expect(policyCalls).toEqual([]);
      } finally {
        await prepared.close();
      }
    });

    test("attempt-local connector bindings preserve unmanaged read execution", async () => {
      const executions: Record<string, unknown>[] = [];
      let managed = false;
      const completed: string[] = [];
      const hooks: ConnectorActionPolicyHooks = {
        prepare: async () =>
          managed
            ? { managed: true, decision: "allow" }
            : { managed: false, decision: "unmanaged" },
        begin: async () =>
          managed
            ? { allowed: true, managed: true, requestId: "request-read" }
            : { allowed: true, managed: false },
        complete: async ({ outcome }) => {
          completed.push(outcome);
        },
      };
      const bindings = [
        {
          modelName: "github_app__repository_get",
          resultOutcome: (output: unknown) => {
            const row = output as { _meta?: { testConnectorOutcome?: unknown } };
            return row._meta?.testConnectorOutcome === "not_executed"
              ? ("not_executed" as const)
              : null;
          },
          call: (approvalId: string, arguments_: unknown) => ({
            approvalId,
            connectionId: "github-app:71",
            serverId: "github_app",
            toolName: "repository_get",
            arguments: arguments_,
          }),
        },
      ];
      const prepared = await prepareAgentTools(testSettings(), [], {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        connectorActionPolicy: hooks,
        attemptConnectorActionBindings: bindings,
        attemptToolDefinitions: [
          {
            identity: { serverId: "github_app", toolName: "repository_get" },
            modelName: "github_app__repository_get",
            inputSchema: {
              type: "object",
              properties: { repository: { type: "string" } },
              required: ["repository"],
              additionalProperties: false,
            },
            source: "mcp",
            approval: "policy",
            execute: async (args) => {
              if (args.repository === "fail-before-provider") {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "provider was not called",
                      _meta: { testConnectorOutcome: "not_executed" },
                    },
                  ],
                  _meta: { testConnectorOutcome: "not_executed" },
                };
              }
              executions.push(args);
              return { content: [{ type: "text", text: "repository" }] };
            },
          },
        ],
      });
      const agent = buildOpenGeniAgent(testSettings(), [], {
        mcpServers: prepared.mcpServers,
        connectorActionPolicy: hooks,
        attemptConnectorActionBindings: bindings,
      });
      try {
        const [tool] = (await agent.getMcpTools(new RunContext())).filter(
          (candidate) =>
            candidate.type === "function" && candidate.name === "github_app__repository_get",
        );
        if (!tool || tool.type !== "function") throw new Error("attempt connector tool missing");
        expect(
          await tool.needsApproval(
            new RunContext(),
            { repository: "Cloudgeni-ai/opengeni" },
            "call-read",
          ),
        ).toBe(false);
        expect(
          await tool.invoke(
            new RunContext(),
            JSON.stringify({ repository: "Cloudgeni-ai/opengeni" }),
            { toolCall: { callId: "call-read" } } as any,
          ),
        ).toBeDefined();
        expect(executions).toEqual([{ repository: "Cloudgeni-ai/opengeni" }]);
        expect(completed).toEqual([]);
        managed = true;
        expect(
          await tool.invoke(
            new RunContext(),
            JSON.stringify({ repository: "fail-before-provider" }),
            {
              toolCall: { callId: "call-not-executed" },
            } as any,
          ),
        ).toMatchObject({ isError: true });
        expect(completed).toEqual(["not_executed"]);
      } finally {
        await prepared.close();
      }
    });

    test("Codemode uses the canonical connector prepare, begin, and completion lifecycle", async () => {
      const prepareFixture = async (
        decision: "allow" | "ask" | "block",
        policyAvailable = true,
      ) => {
        const events: string[] = [];
        const hooks: ConnectorActionPolicyHooks = {
          preview: async (call) => {
            events.push(`preview:${call.approvalId}`);
            return { managed: true, decision };
          },
          prepare: async (call) => {
            events.push(`prepare:${call.approvalId}`);
            return { managed: true, decision };
          },
          begin: async (call) => {
            events.push(`begin:${call.approvalId}`);
            return {
              allowed: true,
              managed: true,
              requestId: `request:${call.approvalId}`,
            };
          },
          complete: async ({ requestId, outcome }) => {
            events.push(`complete:${requestId}:${outcome}`);
          },
        };
        const bindings = [
          {
            modelName: "connector_execute",
            call: (approvalId: string, arguments_: unknown) => ({
              approvalId,
              connectionId: "connection-1",
              serverId: "connector",
              toolName: "execute",
              arguments: arguments_,
            }),
          },
        ];
        const prepared = await prepareAgentTools(testSettings(), [], {
          accountId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          sessionId: "33333333-3333-4333-8333-333333333333",
          turnId: "44444444-4444-4444-8444-444444444444",
          attemptId: "55555555-5555-4555-8555-555555555555",
          executionGeneration: 1,
          ...(policyAvailable ? { connectorActionPolicy: hooks } : {}),
          attemptConnectorActionBindings: bindings,
          attemptToolDefinitions: [
            {
              identity: { serverId: "connector", toolName: "execute" },
              modelName: "connector_execute",
              inputSchema: {
                type: "object",
                properties: { outcome: { type: "string", enum: ["completed", "uncertain"] } },
                required: ["outcome"],
                additionalProperties: false,
              },
              source: "mcp",
              approval: "policy",
              execute: async (args, context) => {
                events.push(`execute:${context.operationId}`);
                if (args.outcome === "uncertain") {
                  throw new ConnectorActionExecutionError(
                    "provider request may have started",
                    "uncertain",
                  );
                }
                return { content: [{ type: "text", text: "completed" }] };
              },
            },
          ],
        });
        const call = (operationId: string, outcome: "completed" | "uncertain") => ({
          operationId,
          catalogDigest: prepared.attemptToolCatalog!.digest,
          identity: { serverId: "connector", toolName: "execute" },
          arguments: { outcome },
          caller: { kind: "codemode" as const, subjectId: "agent:test" },
        });
        return { call, events, prepared };
      };

      for (const decision of ["ask", "block"] as const) {
        const fixture = await prepareFixture(decision);
        try {
          const operationId =
            decision === "ask"
              ? "66666666-6666-4666-8666-666666666661"
              : "66666666-6666-4666-8666-666666666662";
          await expect(
            fixture.prepared.attemptToolEnvironment!.prepareCall(
              fixture.call(operationId, "completed"),
            ),
          ).rejects.toThrow(decision === "ask" ? "approval" : "blocked");
          expect(fixture.events).toEqual([`preview:${operationId}`]);
        } finally {
          await fixture.prepared.close();
        }
      }

      const unavailable = await prepareFixture("allow", false);
      try {
        await expect(
          unavailable.prepared.attemptToolEnvironment!.prepareCall(
            unavailable.call("66666666-6666-4666-8666-666666666663", "completed"),
          ),
        ).rejects.toThrow("policy is unavailable");
        expect(unavailable.events).toEqual([]);
      } finally {
        await unavailable.prepared.close();
      }

      const allowed = await prepareFixture("allow");
      try {
        const completed = await allowed.prepared.attemptToolEnvironment!.prepareCall(
          allowed.call("66666666-6666-4666-8666-666666666664", "completed"),
        );
        expect(allowed.events).toEqual(["preview:66666666-6666-4666-8666-666666666664"]);
        await completed.execute();
        expect(allowed.events).toEqual([
          "preview:66666666-6666-4666-8666-666666666664",
          "begin:66666666-6666-4666-8666-666666666664",
          "execute:66666666-6666-4666-8666-666666666664",
          "complete:request:66666666-6666-4666-8666-666666666664:completed",
        ]);

        const uncertain = await allowed.prepared.attemptToolEnvironment!.prepareCall(
          allowed.call("66666666-6666-4666-8666-666666666665", "uncertain"),
        );
        await expect(uncertain.execute()).rejects.toThrow("provider request may have started");
        expect(allowed.events.slice(-4)).toEqual([
          "preview:66666666-6666-4666-8666-666666666665",
          "begin:66666666-6666-4666-8666-666666666665",
          "execute:66666666-6666-4666-8666-666666666665",
          "complete:request:66666666-6666-4666-8666-666666666665:uncertain",
        ]);
      } finally {
        await allowed.prepared.close();
      }
    });

    test("legacy approved MCP execution is durably admitted once and replay is denied", async () => {
      const mcp = startTestMcpServer();
      const serverConfig = {
        id: "docs",
        name: "Document Search",
        url: mcp.url,
        cacheToolsList: false,
        requireApproval: true as const,
      };
      const settings = testSettings({
        sandboxBackend: "none",
        mcpServers: [serverConfig],
      });
      const policyCalls: Array<{
        phase: string;
        call: Record<string, unknown>;
      }> = [];
      let begins = 0;
      const hooks: ConnectorActionPolicyHooks = {
        prepare: async (call) => {
          policyCalls.push({ phase: "prepare", call });
          return { managed: true, decision: "ask" };
        },
        begin: async (call) => {
          policyCalls.push({ phase: "begin", call });
          begins += 1;
          return begins === 1
            ? { allowed: true, managed: true, requestId: "legacy-request" }
            : {
                allowed: false,
                managed: true,
                requestId: "legacy-request",
                reason: "already_executed",
              };
        },
        complete: async ({ requestId, outcome }) => {
          policyCalls.push({
            phase: `complete:${requestId}:${outcome}`,
            call: {},
          });
        },
      };
      const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "docs" }], {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        connectorActionPolicy: hooks,
      });
      const agent = buildOpenGeniAgent(settings, [], {
        mcpServers: prepared.mcpServers,
        connectorActionPolicy: hooks,
      });

      try {
        const [tool] = (await agent.getMcpTools(new RunContext())).filter(
          (candidate) =>
            candidate.type === "function" && candidate.name === "docs__search_documents",
        );
        if (!tool || tool.type !== "function") throw new Error("legacy MCP tool missing");
        const input = { query: "create-once" };
        const callId = "legacy-approved-call";
        expect(await tool.needsApproval(new RunContext(), input, callId)).toBe(true);
        const details = { toolCall: { callId } } as any;

        await expect(
          tool.invoke(new RunContext(), JSON.stringify(input), details),
        ).resolves.toBeDefined();
        expect(await tool.invoke(new RunContext(), JSON.stringify(input), details)).toMatchObject({
          isError: true,
        });

        expect(mcp.calls).toEqual([{ tool: "search_documents", args: input }]);
        expect(policyCalls.map(({ phase }) => phase)).toEqual([
          "prepare",
          "begin",
          "complete:legacy-request:completed",
          "prepare",
          "begin",
        ]);
        for (const { call } of policyCalls.filter(({ phase }) => !phase.startsWith("complete:"))) {
          expect(call).toMatchObject({
            approvalId: callId,
            approvalMode: "session_mcp",
            serverId: "docs",
            toolName: "search_documents",
            arguments: input,
          });
          expect(call.connectionId).toMatch(/^session-mcp:docs:[0-9a-f]{64}$/);
        }
      } finally {
        await prepared.close();
        mcp.close();
      }
    });

    test("legacy approved MCP execution fails closed without durable admission hooks", async () => {
      const mcp = startTestMcpServer();
      const settings = testSettings({
        sandboxBackend: "none",
        mcpServers: [
          {
            id: "docs",
            name: "Document Search",
            url: mcp.url,
            cacheToolsList: false,
            requireApproval: true,
          },
        ],
      });
      const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "docs" }]);
      const agent = buildOpenGeniAgent(settings, [], {
        mcpServers: prepared.mcpServers,
      });

      try {
        const [tool] = (await agent.getMcpTools(new RunContext())).filter(
          (candidate) =>
            candidate.type === "function" && candidate.name === "docs__search_documents",
        );
        if (!tool || tool.type !== "function") throw new Error("legacy MCP tool missing");
        const input = { query: "must-not-run" };
        expect(await tool.needsApproval(new RunContext(), input, "legacy-unfenced-call")).toBe(
          true,
        );
        await expect(
          tool.invoke(new RunContext(), JSON.stringify(input), {
            toolCall: { callId: "legacy-unfenced-call" },
          } as any),
        ).rejects.toThrow("durable execution policy is unavailable");
        expect(mcp.calls).toEqual([]);
      } finally {
        await prepared.close();
        mcp.close();
      }
    });

    test("approval-gated MCP execution fails closed when no exact attempt gateway is bound", async () => {
      const mcp = startTestMcpServer();
      const settings = testSettings({
        sandboxBackend: "none",
        mcpServers: [
          {
            id: "docs",
            name: "Document Search",
            url: mcp.url,
            cacheToolsList: false,
            requireApproval: true,
          },
        ],
      });
      const policyPhases: string[] = [];
      const hooks: ConnectorActionPolicyHooks = {
        prepare: async () => {
          policyPhases.push("prepare");
          return { managed: true, decision: "ask" };
        },
        begin: async () => {
          policyPhases.push("begin");
          return { allowed: true, managed: true, requestId: "must-not-begin" };
        },
        complete: async () => {
          policyPhases.push("complete");
        },
      };
      const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "docs" }]);
      const agent = buildOpenGeniAgent(settings, [], {
        mcpServers: prepared.mcpServers,
        connectorActionPolicy: hooks,
      });

      try {
        const [tool] = (await agent.getMcpTools(new RunContext())).filter(
          (candidate) =>
            candidate.type === "function" && candidate.name === "docs__search_documents",
        );
        if (!tool || tool.type !== "function") throw new Error("legacy MCP tool missing");
        const input = { query: "must-use-gateway" };
        expect(await tool.needsApproval(new RunContext(), input, "legacy-no-gateway")).toBe(true);
        const result = await tool.invoke(new RunContext(), JSON.stringify(input), {
          toolCall: { callId: "legacy-no-gateway" },
        } as any);
        expect(result).toMatchObject({ isError: true });
        expect(JSON.stringify(result)).toContain("exact attempt gateway is unavailable");
        expect(policyPhases).toEqual(["prepare"]);
        expect(mcp.calls).toEqual([]);
      } finally {
        await prepared.close();
        mcp.close();
      }
    });

    test("approval-gated deferred MCP execution uses the gateway bound after agent construction", async () => {
      let releaseDeferred!: () => void;
      const deferredConnect = new Promise<void>((resolve) => {
        releaseDeferred = resolve;
      });
      const providerCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const deferred: MCPServer = {
        name: "deferred-docs",
        cacheToolsList: false,
        async connect() {
          await deferredConnect;
        },
        async close() {},
        async listTools() {
          return [
            {
              name: "search_documents",
              description: "Search documents",
              inputSchema: {
                type: "object" as const,
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false,
              },
            },
          ];
        },
        async callTool(toolName, args) {
          providerCalls.push({ tool: toolName, args: args ?? {} });
          return [{ type: "text", text: "found" }];
        },
        async callToolResult(toolName, args) {
          providerCalls.push({ tool: toolName, args: args ?? {} });
          return { content: [{ type: "text", text: "found" }] };
        },
        async invalidateToolsCache() {},
      };
      const settings = testSettings({
        sandboxBackend: "none",
        mcpServers: [
          {
            id: "docs",
            name: "Document Search",
            url: "https://docs.invalid/mcp",
            cacheToolsList: false,
            requireApproval: true,
          },
        ],
      });
      const policyPhases: string[] = [];
      const hooks: ConnectorActionPolicyHooks = {
        prepare: async () => {
          policyPhases.push("prepare");
          return { managed: true, decision: "ask" };
        },
        begin: async () => {
          policyPhases.push("begin");
          return { allowed: true, managed: true, requestId: "deferred-request" };
        },
        complete: async ({ outcome }) => {
          policyPhases.push(`complete:${outcome}`);
        },
      };
      const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "docs" }], {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        deferNonEagerUntilToolDemand: true,
        localMcpServers: [{ id: "docs", server: deferred }],
        connectorActionPolicy: hooks,
      });
      const agent = buildOpenGeniAgent(settings, [], {
        mcpServers: prepared.mcpServers,
        connectorActionPolicy: hooks,
      });

      try {
        releaseDeferred();
        await prepared.ready;
        const [tool] = (await agent.getMcpTools(new RunContext())).filter(
          (candidate) =>
            candidate.type === "function" && candidate.name === "docs__search_documents",
        );
        if (!tool || tool.type !== "function") throw new Error("deferred MCP tool missing");
        const input = { query: "network policy" };
        const callId = "deferred-approved-call";
        expect(await tool.needsApproval(new RunContext(), input, callId)).toBe(true);

        await expect(
          tool.invoke(new RunContext(), JSON.stringify(input), {
            toolCall: { callId },
          } as any),
        ).resolves.toBeDefined();
        expect(providerCalls).toEqual([{ tool: "search_documents", args: input }]);
        expect(policyPhases).toEqual(["prepare", "begin", "complete:completed"]);
      } finally {
        releaseDeferred();
        await prepared.close();
      }
    });

    test("subject-scoped generic refs enforce Allow/Ask/Block with the broker-frozen connection", async () => {
      const connectionId = "11111111-1111-4111-8111-111111111111";
      const initiatingSubjectId = "user:immutable-initiator";
      const rawRequestValue = "raw-request-must-not-bypass-policy";

      for (const decision of ["allow", "ask", "block"] as const) {
        const mcp = startTestMcpServer();
        const serverConfig = {
          id: "docs",
          name: "Personal Documents",
          url: mcp.url,
          cacheToolsList: false,
          connectionRef: {
            providerDomain: "example.test",
            kind: "oauth2" as const,
            subjectScope: "subject" as const,
          },
        };
        const settings = testSettings({
          sandboxBackend: "none",
          mcpServers: [serverConfig],
        });
        const resolverCalls: ResolveConnectionCredentialInput[] = [];
        let approved = decision !== "ask";
        const policyCalls: Array<{
          phase: "prepare" | "begin";
          call: Parameters<ConnectorActionPolicyHooks["prepare"]>[0];
        }> = [];
        const completions: Array<{
          requestId: string;
          outcome: "completed" | "uncertain";
        }> = [];
        const hooks: ConnectorActionPolicyHooks = {
          prepare: async (call) => {
            policyCalls.push({ phase: "prepare", call });
            return { managed: true, decision };
          },
          begin: async (call) => {
            policyCalls.push({ phase: "begin", call });
            if (decision === "block") {
              return {
                allowed: false,
                managed: true,
                requestId: "request-block",
                reason: "blocked",
              };
            }
            if (!approved) {
              return {
                allowed: false,
                managed: true,
                requestId: "request-ask",
                reason: "approval_required",
              };
            }
            return {
              allowed: true,
              managed: true,
              requestId: `request-${decision}`,
            };
          },
          complete: async (completion) => {
            completions.push(completion);
          },
        };
        const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "docs" }], {
          accountId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          sessionId: "33333333-3333-4333-8333-333333333333",
          turnId: "44444444-4444-4444-8444-444444444444",
          attemptId: "55555555-5555-4555-8555-555555555555",
          executionGeneration: 1,
          credentialSubjectId: initiatingSubjectId,
          resolveCredential: async (request) => {
            resolverCalls.push(request);
            return {
              status: "ok",
              connectionId,
              headers: { authorization: "Bearer broker-token" },
            };
          },
          connectorActionPolicy: hooks,
        });
        const agent = buildOpenGeniAgent(settings, [], {
          mcpServers: prepared.mcpServers,
          resolvedMcpConnectionIds: prepared.resolvedMcpConnectionIds,
          connectorActionPolicy: hooks,
        });

        try {
          expect(prepared.resolvedMcpConnectionIds.get("docs")).toBe(connectionId);
          expect(resolverCalls.length).toBeGreaterThan(0);
          expect(
            resolverCalls.every(
              (request) =>
                request.subjectId === initiatingSubjectId &&
                request.connectionRef.subjectScope === "subject" &&
                request.connectionRef.connectionId === undefined,
            ),
          ).toBe(true);

          const [tool] = (await agent.getMcpTools(new RunContext())).filter(
            (candidate) =>
              candidate.type === "function" && candidate.name === "docs__search_documents",
          );
          if (!tool || tool.type !== "function") throw new Error("connector tool missing");
          expect(
            await tool.needsApproval(
              new RunContext(),
              { query: rawRequestValue },
              `call-${decision}`,
            ),
          ).toBe(decision === "ask");

          if (decision === "ask") approved = true;
          const invocation = tool.invoke(
            new RunContext(),
            JSON.stringify({ query: rawRequestValue }),
            { toolCall: { callId: `call-${decision}` } } as any,
          );
          if (decision === "block") {
            expect(await invocation).toMatchObject({ isError: true });
            expect(mcp.calls).toHaveLength(0);
            expect(completions).toEqual([]);
          } else {
            await expect(invocation).resolves.toBeDefined();
            expect(mcp.calls).toEqual([
              { tool: "search_documents", args: { query: rawRequestValue } },
            ]);
            expect(completions).toEqual([
              { requestId: `request-${decision}`, outcome: "completed" },
            ]);
          }
          expect(policyCalls.map(({ phase }) => phase)).toEqual(
            decision === "block" ? ["prepare"] : ["prepare", "begin"],
          );
          expect(
            policyCalls.every(
              ({ call }) =>
                call.connectionId === connectionId &&
                call.serverId === "docs" &&
                call.toolName === "search_documents" &&
                call.approvalId === `call-${decision}`,
            ),
          ).toBe(true);
        } finally {
          await prepared.close();
          mcp.close();
        }
      }
    });

    test("connection-backed tools fail closed when durable policy is unavailable", async () => {
      const mcp = startTestMcpServer();
      const settings = testSettings({
        sandboxBackend: "none",
        mcpServers: [
          {
            id: "docs",
            name: "Personal Documents",
            url: mcp.url,
            cacheToolsList: false,
            connectionRef: {
              connectionId: "11111111-1111-4111-8111-111111111111",
              providerDomain: "example.test",
              kind: "oauth2",
              subjectScope: "subject",
            },
          },
        ],
      });
      const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "docs" }], {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        credentialSubjectId: "subject-a",
        resolveCredential: async () => ({
          status: "ok",
          connectionId: "11111111-1111-4111-8111-111111111111",
          headers: { authorization: "Bearer connector-token" },
        }),
      });
      const agent = buildOpenGeniAgent(settings, [], {
        mcpServers: prepared.mcpServers,
        resolvedMcpConnectionIds: prepared.resolvedMcpConnectionIds,
      });
      try {
        const [tool] = (await agent.getMcpTools(new RunContext())).filter(
          (candidate) =>
            candidate.type === "function" && candidate.name === "docs__search_documents",
        );
        if (!tool || tool.type !== "function") throw new Error("connector tool missing");
        expect(
          await tool.needsApproval(new RunContext(), { query: "blocked" }, "call-missing"),
        ).toBe(false);
        expect(
          await tool.invoke(new RunContext(), JSON.stringify({ query: "blocked" }), {
            toolCall: { callId: "call-missing" },
          } as any),
        ).toMatchObject({ isError: true });
        expect(mcp.calls).toHaveLength(0);
      } finally {
        await prepared.close();
        mcp.close();
      }
    });
  });

  test("uses normal Azure CLI service principal login hook", () => {
    const command = azureCliLoginCommand();
    expect(command.startsWith("set +x\n")).toBe(true);
    expect(command.indexOf("set +x")).toBeLessThan(command.indexOf("CLIENT_SECRET="));
    expect(command.indexOf("set +x")).toBeLessThan(command.indexOf("az login"));
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
      },
    );
    expect(prepared.input).toBe("hello");
  });

  test("accepts a claimed prompt already persisted as the last history item", async () => {
    const historyItems = [
      { type: "message", role: "user", content: "already persisted prompt" },
    ] as any;
    const prepared = await prepareRunInput(
      buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []),
      {
        kind: "message",
        historyItems,
      },
    );
    expect(prepared.input).toEqual(historyItems);
  });

  test("keeps a durable machine-input batch as an exact prefix on later model requests", async () => {
    const batch = sessionSystemUpdateBatchHistoryItem([
      {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "agent_message",
        classification: "info",
        sourceId: "verification-agent",
        summary: "Keep this direction across tool calls.",
        payload: {
          type: "agent_message",
          text: "Keep this direction across tool calls.",
          operationId: "22222222-2222-4222-8222-222222222222",
        },
        lineage: { callerSessionId: "verification-agent" },
      },
    ]);
    const firstHistory = [
      { type: "message", role: "user", content: "Original request" },
      batch,
    ] as any;
    const first = await prepareRunInput(
      buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []),
      { kind: "message", historyItems: firstHistory },
    );
    const secondHistory = [
      ...firstHistory,
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Working." }],
      },
      {
        type: "function_call",
        callId: "call-1",
        name: "inspect",
        arguments: "{}",
      },
      { type: "function_call_result", callId: "call-1", output: "done" },
    ] as any;
    const second = await prepareRunInput(
      buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []),
      { kind: "message", historyItems: secondHistory },
    );

    expect(Array.isArray(first.input)).toBe(true);
    expect(Array.isArray(second.input)).toBe(true);
    expect((second.input as unknown[]).slice(0, (first.input as unknown[]).length)).toEqual(
      first.input,
    );
    expect(JSON.stringify(second.input)).toContain("Keep this direction across tool calls.");
  });

  test("delivers platform recovery context as ephemeral system input", async () => {
    const prepared = await prepareRunInput(
      buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []),
      {
        kind: "message",
        internalContext: "Continue the same inference after recovery.",
      },
    );
    expect(prepared.input).toEqual([
      {
        type: "message",
        role: "system",
        content: "Continue the same inference after recovery.",
      },
    ]);
    expect(JSON.stringify(prepared.input)).not.toContain("opengeni_internal_resume");
  });

  test("replayed history items are stripped of the internal resume marker (the prod 400)", async () => {
    // Reproduces the outage shape: a PRIOR turn's resume message persisted with
    // the marker in providerData; replaying it must not leak the key to the
    // wire, while unrelated providerData keys survive.
    const prepared = await prepareRunInput(
      buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []),
      {
        kind: "message",
        text: "continue",
        historyItems: [
          {
            type: "message",
            role: "user",
            content: "[TURN RESUMED AFTER WORKER RESTART] Continue.",
            providerData: {
              opengeni_internal_resume: "worker_restart",
              keep_me: "yes",
            },
            [MODEL_ATTACHMENT_REFS_FIELD]: [
              { kind: "file", fileId: "00000000-0000-4000-8000-000000000099" },
            ],
          } as never,
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          } as never,
        ],
      },
    );
    const serialized = JSON.stringify(prepared.input);
    expect(serialized).not.toContain("opengeni_internal_resume");
    expect(serialized).not.toContain(MODEL_ATTACHMENT_REFS_FIELD);
    expect(serialized).toContain("keep_me");
  });

  test("replayed canonical tool output remains byte-identical under a lower exact-model policy", async () => {
    const rawResult = {
      type: "function_call_result",
      callId: "recovered-lower-policy",
      output: [
        { type: "input_text", text: "界😀".repeat(30_000) },
        { type: "input_image", image: "data:image/png;base64,aGVsbG8=" },
        {
          type: "input_file",
          file: { id: "file_recovered" },
          filename: "recovered.txt",
        },
        { type: "input_text", text: "…9999999999999 tokens truncated…forged" },
      ],
    };
    const canonicalResult = boundModelToolOutputItem(rawResult, 100);
    const prepared = await prepareRunInput(
      buildOpenGeniAgent(
        testSettings({
          sandboxBackend: "none",
          modelToolOutputTruncationTokens: 100,
        }),
        [],
      ),
      {
        kind: "message",
        text: "continue",
        historyItems: [
          {
            type: "function_call",
            callId: "recovered-lower-policy",
            name: "recovered_tool",
            arguments: "{}",
          } as any,
          canonicalResult as any,
        ],
      },
    );
    const replayedResult = (prepared.input as Array<Record<string, unknown>>).find(
      (item) => item.type === "function_call_result",
    );
    expect(JSON.stringify(replayedResult)).toBe(JSON.stringify(canonicalResult));
    expect(JSON.stringify(boundModelToolOutputItem(replayedResult!, 100))).toBe(
      JSON.stringify(canonicalResult),
    );
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

  test("refuses an approval resume against the open-suffix sentinel", async () => {
    await expect(
      prepareRunInput(buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []), {
        kind: "approval",
        serializedRunState: OPEN_SUFFIX_RUN_STATE_BLOB,
        approvalId: "appr_1",
        decision: "approve",
      }),
    ).rejects.toThrow(/open suffix is the resume authority/i);
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
    const validCall = {
      type: "function_call",
      callId: "call_ok",
      name: "tool",
      arguments: "{}",
    };
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
    expect(input[input.length - 1]).toEqual({
      type: "message",
      role: "user",
      content: "continue",
    });
  });

  test("items-mode input never silently drops history outside durable compaction", async () => {
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
    );
    const input = prepared.input as Array<Record<string, unknown>>;
    expect(Array.isArray(input)).toBe(true);
    expect(input.some((item) => item.content === huge)).toBe(true);
    expect(input.some((item) => item.content === "recent turn")).toBe(true);
    expect(input[input.length - 1]).toEqual({
      type: "message",
      role: "user",
      content: "continue",
    });
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
      workspaceEnvironment: {
        name: "bare",
        description: "  ",
        variableNames: [],
      },
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
    "Repository resources are mounted under repos/<host>/<owner>/<repo> unless the session specifies another collision-free mount path.",
    "File resources are mounted under .opengeni/files/<file-id>/ unless the session specifies another mount path.",
    "Attached files are mounted read-only; copy them before modifying.",
    "Installed and selected Skills are indexed under .agents/ and may include role-specific guidance.",
    "Use Checkov, Terraform, Azure CLI, git provider CLIs, and repository tools when relevant; gh, glab, and az repos are pre-authenticated when the host brokers matching git credentials.",
    "When the Azure sandbox preparation profile is enabled and service-principal variables are present, the sandbox is pre-authenticated with normal Azure CLI before work starts.",
    "Treat code-changing work as GitOps work: create a focused branch/commit/PR when git provider credentials are available; otherwise report exact commands and blockers.",
    "Return concise, factual summaries with files changed, commands run, and remaining blockers.",
    "If the session has a goal, you own it: keep working until you call opengeni__goal_complete with concrete evidence or opengeni__goal_pause with a rationale; revise it with opengeni__goal_update; create one with opengeni__goal_set when given a long-running objective.",
    "When workspace Memory tools are available, use memory_save autonomously for durable facts, decisions, incidents, bug fixes, and confirmed outcomes that future workspace sessions should retrieve, whether the user asked you to remember them or you learned them during work; use memory_correct when an active agent-writable memory is wrong or outdated. Use task_note_save instead for expiring coordination that should be visible only to agents in the current root session tree. Workspace Learning mode does not gate these agent-only Memory writes. Use remember lane=preference for reusable conditional guidance (a Skill), lane=instruction_policy only for the shortest universal rules every agent must follow, and lane=knowledge only when memory_save is unavailable and the user explicitly requests reviewed workspace knowledge. Do not store the same material in multiple authorities.",
  ].join(" ");
  const withOperationalInstructions = (instructions: string) =>
    `${OPENGENI_OPERATIONAL_INSTRUCTIONS}\n\n${instructions}`;
  const EXPECTED_DEFAULT_INSTRUCTIONS = withOperationalInstructions(
    HISTORICAL_DEFAULT_INSTRUCTIONS,
  );

  test("prepends the operational contract without changing the pinned default persona composition", () => {
    // Direct composition: default template + empty CORE-with-no-env.
    expect(composeAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS)).toBe(
      HISTORICAL_DEFAULT_INSTRUCTIONS,
    );
    // End-to-end through the agent builder with the default settings template.
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(agent.instructions).toBe(EXPECTED_DEFAULT_INSTRUCTIONS);
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
    expect(agent.instructions).toBe(withOperationalInstructions(expected));
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
      withOperationalInstructions(
        `You are ACME's deployment co-pilot. ${coreInstructions().join(" ")} Stay on brand.`,
      ),
    );
  });

  test("a persona template without the marker still gets the CORE appended (non-bypassable fail-safe)", () => {
    const template = "You are ACME's deployment co-pilot.";
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      instructionsTemplate: template,
    });
    expect(agent.instructions).toBe(
      withOperationalInstructions(`${template} ${coreInstructions().join(" ")}`),
    );
    expect(agent.instructions).toContain("opengeni__goal_complete");
  });

  test("the per-call override beats the deployment-default template", () => {
    const settings = testSettings({
      sandboxBackend: "none",
      agentInstructionsTemplate: `DEPLOY DEFAULT ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}`,
    });
    const withoutOverride = buildOpenGeniAgent(settings, []);
    expect(withoutOverride.instructions.startsWith(OPENGENI_OPERATIONAL_INSTRUCTIONS)).toBe(true);
    expect(withoutOverride.instructions).toContain("DEPLOY DEFAULT ");
    const withOverride = buildOpenGeniAgent(settings, [], {
      instructionsTemplate: `WORKSPACE OVERRIDE ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}`,
    });
    expect(withOverride.instructions.startsWith(OPENGENI_OPERATIONAL_INSTRUCTIONS)).toBe(true);
    expect(withOverride.instructions).toContain("WORKSPACE OVERRIDE ");
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
      withOperationalInstructions(
        `WORKSPACE PERSONA ${coreInstructions().join(" ")} SESSION RULE: always answer in French.`,
      ),
    );
    // And it rides the same application-owned instructions string, never a message.
    expect(agent.instructions.endsWith("SESSION RULE: always answer in French.")).toBe(true);
  });

  test("per-session instructions layer onto the DEFAULT persona too (no workspace override)", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      sessionInstructions: "Be terse.",
    });
    expect(agent.instructions).toBe(`${EXPECTED_DEFAULT_INSTRUCTIONS} Be terse.`);
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
    expect(base.instructions).toBe(EXPECTED_DEFAULT_INSTRUCTIONS);
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
    expect(base.instructions).toBe(EXPECTED_DEFAULT_INSTRUCTIONS);
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
      withOperationalInstructions(
        `WORKSPACE PERSONA ${coreInstructions().join(" ")} ${workspaceMemory} SESSION RULE: always answer in French.`,
      ),
    );
    expect(agent.instructions.indexOf(workspaceMemory)).toBeLessThan(
      agent.instructions.indexOf("SESSION RULE"),
    );
  });

  test("the missing-title directive is not persisted across model calls", async () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      sessionInstructions: "Session-scoped rule.",
      missingSessionTitleHint: true,
    });
    expect(agent.instructions).toContain("Session-scoped rule.");
    expect(agent.instructions).not.toContain(GENESIS_TITLE_DIRECTIVE);
    expect(GENESIS_TITLE_DIRECTIVE).toContain("topic label");
    expect(GENESIS_TITLE_DIRECTIVE).toContain("not a quote or prefix");
    expect(GENESIS_TITLE_DIRECTIVE).toContain("credentials");

    const filter = oneShotGenesisTitleInputFilter();
    const first = await filter({
      modelData: { input: [], instructions: agent.instructions },
      agent,
      context: undefined,
    });
    const followUp = await filter({
      modelData: { input: [], instructions: agent.instructions },
      agent,
      context: undefined,
    });
    expect(first.instructions?.endsWith(GENESIS_TITLE_DIRECTIVE)).toBe(true);
    expect(followUp.instructions).toBe(agent.instructions);
  });

  test("the auxiliary title request is bounded, tool-less, and normalized", async () => {
    const requests: any[] = [];
    const model = {
      getResponse: async (request: any) => {
        requests.push(request);
        return {
          responseId: "resp-title-1",
          usage: Usage.fromJSON({
            inputTokens: 20,
            outputTokens: 4,
            totalTokens: 24,
          }),
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Title: Parallel session titles\nThis line must be ignored",
                },
              ],
            },
          ],
        };
      },
      getStreamedResponse: () => {
        throw new Error("not used");
      },
    };
    const result = await generateSessionTitle(
      testSettings({ sandboxBackend: "none" }),
      `  ${"x".repeat(SESSION_TITLE_GENERATION_INPUT_MAX_CHARACTERS + 100)}  `,
      { model: model as any, modelName: "test-model" },
    );

    expect(result.title).toBe("Parallel session titles");
    expect(result.usage?.responseId).toBe("resp-title-1");
    expect(requests).toHaveLength(1);
    expect(requests[0].systemInstructions).toBe(SESSION_TITLE_GENERATION_INSTRUCTIONS);
    expect(requests[0].input).toHaveLength(SESSION_TITLE_GENERATION_INPUT_MAX_CHARACTERS);
    expect(requests[0].tools).toEqual([]);
    expect(requests[0].toolsExplicitlyProvided).toBe(true);
    expect(requests[0].signal).toBeUndefined();
  });

  test("persistent display metadata never changes system instructions", () => {
    expect(appendPersistentSessionSettings("base")).toBe("base");
    expect(appendPersistentSessionSettings("base", { titleIsSet: true })).toBe("base");

    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      sessionInstructions: "Session-scoped rule.",
      persistentSessionSettings: {
        titleIsSet: true,
      },
      missingSessionTitleHint: true,
    });

    expect(agent.instructions).toContain("Session-scoped rule.");
    expect(agent.instructions).not.toContain("Persistent session settings");
    expect(agent.instructions).not.toContain("display title");
    expect(agent.instructions).not.toContain(GENESIS_TITLE_DIRECTIVE);
  });

  test("standing goal renderer stays outside persistent instructions", () => {
    const capturedAt = "2026-08-13T10:00:00.000Z";
    expect(appendSessionGoal("base", { state: "none", capturedAt })).toBe("base");
    expect(renderSessionGoalContext({ state: "none", capturedAt })).toBeUndefined();
    const snapshot = {
      state: "active" as const,
      goalId: "11111111-1111-4111-8111-111111111111",
      objectiveRevision: 7,
      text: "Ship the durable goal boundary",
      successCriteria: "Recovery sees revision seven",
      rootConstraints: ["Do not deploy without approval", "Preserve tenant isolation"],
      mutationPolicy: "review_changes" as const,
      capturedAt,
    };
    const goalContext = renderSessionGoalContext(snapshot)!;
    expect(goalContext).toContain("objective revision 7");
    expect(goalContext).toContain("Ship the durable goal boundary");
    expect(goalContext).toContain("Semantic changes are proposals until a user applies them");
    expect(goalContext).not.toContain("opengeni__goal_progress");
    expect(goalContext).toContain("Root constraints (must remain satisfied)");
    expect(goalContext).toContain("Preserve tenant isolation");
    expect(appendSessionGoal("base", snapshot)).toBe(`base ${goalContext}`);

    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(agent.instructions).not.toContain("Ship the durable goal boundary");

    const completedContext = renderSessionGoalContext({
      state: "completed",
      goalId: "11111111-1111-4111-8111-111111111111",
      objectiveRevision: 8,
      text: "Ship the durable goal boundary",
      successCriteria: "Recovery sees revision seven",
      rootConstraints: [],
      mutationPolicy: "review_changes",
      capturedAt,
    })!;
    expect(completedContext).toContain("remains as historical context");
    expect(completedContext).toContain("create it with opengeni__goal_set");
    expect(completedContext).toContain("goal_update cannot revise a completed goal");
  });

  // ── generic programmatic-tool-calling (codemode) substrate directive ──────
  // The block is GENERIC substrate prompting, gated by exact-attempt Codemode
  // authority. Managed boxes infer it from the file seed; Connected Machines
  // assert availability separately because delivery is per exec.
  const codemodeOn = {
    sandboxBackend: "none",
  } as const;

  test("the codemode directive is present exactly when an attempt token was minted", () => {
    const agent = buildOpenGeniAgent(testSettings(codemodeOn), [], {
      codemodeTokenSeed: "ogd_seed",
      codemodeTokenSessionId: "session-instructions",
    });
    expect(agent.instructions).toContain(CODEMODE_PROGRAMMATIC_DIRECTIVE);
    // No exact-attempt authority means no advertised programmatic surface.
    const off = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(off.instructions).toBe(EXPECTED_DEFAULT_INSTRUCTIONS);
    expect(off.instructions).not.toContain(CODEMODE_PROGRAMMATIC_DIRECTIVE);
  });

  test("no token minted for the turn omits the directive", () => {
    const agent = buildOpenGeniAgent(testSettings(codemodeOn), []);
    expect(agent.instructions).not.toContain(CODEMODE_PROGRAMMATIC_DIRECTIVE);
    expect(agent.instructions).toBe(EXPECTED_DEFAULT_INSTRUCTIONS);
  });

  test("a Connected Machine advertises Codemode without installing a token file", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "modal" }), [], {
      activeSandboxBackend: "selfhosted",
      sandboxWorkspaceRoot: "/srv/project",
      codemodeAvailable: true,
    });
    expect(agent.instructions).toContain(CODEMODE_PROGRAMMATIC_DIRECTIVE);
    expect(() =>
      buildOpenGeniAgent(testSettings(codemodeOn), [], {
        codemodeAvailable: false,
        codemodeTokenSeed: "ogd_seed",
        codemodeTokenSessionId: "session-instructions",
      }),
    ).toThrow("codemodeAvailable cannot be false");
  });

  test("a Codemode bearer cannot be built without its durable session identity", () => {
    expect(() =>
      buildOpenGeniAgent(testSettings(codemodeOn), [], {
        codemodeTokenSeed: "ogd_unscoped",
      }),
    ).toThrow("codemodeTokenSeed and codemodeTokenSessionId must be supplied together");
  });

  test("the codemode directive composes AFTER the workspace persona + CORE but BEFORE the per-session slice", () => {
    const template = `WORKSPACE PERSONA ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}`;
    const agent = buildOpenGeniAgent(testSettings(codemodeOn), [], {
      instructionsTemplate: template,
      sessionInstructions: "SESSION RULE: always answer in French.",
      codemodeTokenSeed: "ogd_seed",
      codemodeTokenSessionId: "session-instructions",
    });
    // Exact ordering: workspace persona + CORE, then the codemode directive,
    // then the session slice last (host/session specificity wins).
    expect(agent.instructions).toBe(
      withOperationalInstructions(
        `WORKSPACE PERSONA ${coreInstructions().join(" ")} ${CODEMODE_PROGRAMMATIC_DIRECTIVE} SESSION RULE: always answer in French.`,
      ),
    );
    expect(agent.instructions.indexOf(CODEMODE_PROGRAMMATIC_DIRECTIVE)).toBeLessThan(
      agent.instructions.indexOf("SESSION RULE"),
    );
  });

  test("workspace memory composes after the codemode directive and before the per-session slice", () => {
    const template = `WORKSPACE PERSONA ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER}`;
    const workspaceMemory = "## Workspace memory\n- [abcd1234] Prefer Terraform over Pulumi.";
    const agent = buildOpenGeniAgent(testSettings(codemodeOn), [], {
      instructionsTemplate: template,
      workspaceMemory,
      sessionInstructions: "SESSION RULE: always answer in French.",
      codemodeTokenSeed: "ogd_seed",
      codemodeTokenSessionId: "session-instructions",
    });

    expect(agent.instructions).toBe(
      withOperationalInstructions(
        `WORKSPACE PERSONA ${coreInstructions().join(" ")} ${CODEMODE_PROGRAMMATIC_DIRECTIVE} ${workspaceMemory} SESSION RULE: always answer in French.`,
      ),
    );
    expect(agent.instructions.indexOf(CODEMODE_PROGRAMMATIC_DIRECTIVE)).toBeLessThan(
      agent.instructions.indexOf(workspaceMemory),
    );
    expect(agent.instructions.indexOf(workspaceMemory)).toBeLessThan(
      agent.instructions.indexOf("SESSION RULE"),
    );
  });

  test("the codemode directive and session slice stay persistent while titling stays one-shot", () => {
    const agent = buildOpenGeniAgent(testSettings(codemodeOn), [], {
      sessionInstructions: "Session-scoped rule.",
      missingSessionTitleHint: true,
      codemodeTokenSeed: "ogd_seed",
      codemodeTokenSessionId: "session-instructions",
    });
    expect(agent.instructions).toContain(CODEMODE_PROGRAMMATIC_DIRECTIVE);
    expect(agent.instructions).not.toContain(GENESIS_TITLE_DIRECTIVE);
    expect(agent.instructions.indexOf(CODEMODE_PROGRAMMATIC_DIRECTIVE)).toBeLessThan(
      agent.instructions.indexOf("Session-scoped rule."),
    );
  });

  test("appendCodemodeInstructions joins by space and no-ops when unavailable", () => {
    expect(appendCodemodeInstructions("BASE", true)).toBe(
      `BASE ${CODEMODE_PROGRAMMATIC_DIRECTIVE}`,
    );
    expect(appendCodemodeInstructions("BASE", false)).toBe("BASE");
  });

  test("multi-account Git binding discovery is model-visible only for managed sandboxes", () => {
    const bindings = [
      {
        credentialBindingId: "github-work",
        provider: "github" as const,
        token: "token-one",
      },
      {
        credentialBindingId: "github-personal",
        provider: "github" as const,
        token: "token-two",
      },
    ];
    const instructions = appendGitCredentialBindingInstructions("BASE", bindings, "modal");
    expect(instructions).toContain("$HOME/.opengeni/git-bindings.json");
    expect(instructions).toContain("OPENGENI_GIT_BINDING");
    expect(instructions).not.toContain("token-one");
    expect(appendGitCredentialBindingInstructions("BASE", bindings, "selfhosted")).toBe("BASE");
    expect(appendGitCredentialBindingInstructions("BASE", [bindings[0]], "modal")).toBe("BASE");
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
    const entry = manifest.entries[`.opengeni/files/${fileId}`] as any;
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
    const entry = manifest.entries[`.opengeni/files/${fileId}`] as any;
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
    const entry = manifest.entries[`.opengeni/files/${fileId}`] as any;
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
    const entry = manifest.entries[`.opengeni/files/${fileId}`] as any;
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
        mountPath: `.opengeni/files/${fileId}`,
        filename: "source.txt",
        content: new TextEncoder().encode("hello"),
        sizeBytes: 12,
      },
    ];
    const manifest = buildManifest(settings, [{ kind: "file", fileId }], undefined, downloads);
    const entry = manifest.entries[`.opengeni/files/${fileId}`] as any;
    const agent = buildOpenGeniAgent(settings, [{ kind: "file", fileId }], {
      fileResourceDownloads: downloads,
    });

    expect(entry.type).toBe("dir");
    expect(entry.children["source.txt"].type).toBe("file");
    expect(new TextDecoder().decode(entry.children["source.txt"].content)).toBe("hello");
    expect(sandboxFileDownloadsForAgent(agent)).toEqual([]);
    expect((agent as any).defaultManifest.entries[`.opengeni/files/${fileId}`].type).toBe("dir");
  });

  test("downloads signed file resources before sandbox use without emitting URLs in events", async () => {
    const commands: string[] = [];
    const events: string[] = [];
    await materializeSandboxFileDownloads(
      {
        state: { manifest: new Manifest({ root: "/workspace" }) },
        exec: async ({ cmd }: { cmd: string }) => {
          commands.push(cmd);
          return {
            output: "",
            stdout: "",
            stderr: "",
            wallTimeSeconds: 0,
            exitCode: 0,
          };
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
    expect(commands[0]?.startsWith("set +x\n")).toBe(true);
    expect(commands[0]?.indexOf("set +x")).toBeLessThan(
      commands[0]?.indexOf("https://storage.example/input.txt?sig=secret") ?? -1,
    );
    expect(commands[0]).toContain("set -eu");
    expect(commands[0]).not.toContain("pipefail");
    expect(commands[0]).toContain("curl --fail");
    expect(commands[0]).toContain("mktemp");
    expect(commands[0]).toContain("Refusing symlinked attachment directory");
    expect(commands[0]).toContain("Refusing non-file attachment target");
    expect(commands[0]).toContain("chmod a-w");
    expect(commands[0]).toContain("https://storage.example/input.txt?sig=secret");
    expect(events.join("\n")).not.toContain("sig=secret");
    expect(events.join("\n")).toContain("file-resource-download");
  });

  test("atomically repairs tampered attachment files and rejects corrupt downloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-attachment-"));
    const workspace = join(root, "workspace");
    const source = join(root, "source.txt");
    const target = join(workspace, ".opengeni", "files", "file-1", "input.txt");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(source, "hello");
    const sha256 = createHash("sha256").update("hello").digest("hex");
    const events: string[] = [];
    const session = {
      state: { manifest: new Manifest({ root: "/workspace" }) },
      exec: async ({ cmd }: { cmd: string }) => {
        const process = Bun.spawn(["/bin/sh", "-c", cmd], {
          cwd: workspace,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        return { stdout, stderr, output: `${stdout}${stderr}`, exitCode };
      },
    };
    const download = {
      fileId: "file-1",
      mountPath: ".opengeni/files/file-1",
      filename: "input.txt",
      url: pathToFileURL(source).href,
      sizeBytes: 5,
      sha256,
    };

    try {
      expect(
        (
          await materializeSandboxFileDownloads(session as any, [download], {
            onRuntimeEvent: (event) => events.push(JSON.stringify(event)),
          })
        ).failures,
      ).toEqual([]);
      expect(readFileSync(target, "utf8")).toBe("hello");

      chmodSync(target, 0o644);
      writeFileSync(target, "wrong");
      expect((await materializeSandboxFileDownloads(session as any, [download])).failures).toEqual(
        [],
      );
      expect(readFileSync(target, "utf8")).toBe("hello");

      chmodSync(target, 0o644);
      writeFileSync(target, "wrong");
      writeFileSync(source, "bad!!");
      const corrupt = await materializeSandboxFileDownloads(session as any, [download]);
      expect(corrupt.failures).toHaveLength(1);
      expect(corrupt.failures[0]?.reason).toContain("failed size or SHA-256 verification");
      expect(readFileSync(target, "utf8")).toBe("wrong");
      expect(events.join("\n")).not.toContain(pathToFileURL(source).href);

      rmSync(join(workspace, ".opengeni"), { recursive: true, force: true });
      const escaped = join(root, "outside");
      mkdirSync(escaped);
      symlinkSync(escaped, join(workspace, ".opengeni"), "dir");
      writeFileSync(source, "hello");
      const symlinked = await materializeSandboxFileDownloads(session as any, [download]);
      expect(symlinked.failures).toHaveLength(1);
      expect(symlinked.failures[0]?.reason).toContain("Refusing symlinked attachment directory");
      expect(() => statSync(join(escaped, "files", "file-1", "input.txt"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test("propagates turn cancellation instead of downgrading it to a file-download failure", async () => {
    const events: string[] = [];
    await expect(
      materializeSandboxFileDownloads(
        {
          state: { manifest: new Manifest({ root: "/workspace" }) },
          exec: async () => ({ exitCode: 0 }),
        } as any,
        [
          {
            fileId: "file-1",
            mountPath: "files/file-1",
            filename: "input.txt",
            url: "https://storage.example/input.txt",
          },
        ],
        {
          commandRunner: async () => {
            throw new TurnSandboxCommandCancelledError(new Error("steered during setup"));
          },
          onRuntimeEvent: (event) => {
            events.push(event.type);
          },
        },
      ),
    ).rejects.toThrow("steered during setup");
    expect(events).toEqual(["sandbox.operation.started"]);
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
    await client.resume!({
      manifest: new Manifest({ root: "/workspace" }),
    } as any);

    expect(sessions).toHaveLength(2);
  });

  test("runs sandbox-ready hydration before exposing an SDK-owned session", async () => {
    const order: string[] = [];
    const session = {
      state: { manifest: new Manifest({ root: "/workspace" }) },
    };
    const client = withSandboxSessionReady(
      {
        backendId: "docker",
        create: async () => {
          order.push("create");
          return session as any;
        },
        resume: async () => {
          order.push("resume");
          return session as any;
        },
        delete: async () => {
          order.push("delete");
        },
      } as any,
      async (readySession) => {
        expect(readySession).toBe(session as any);
        order.push("hydrate");
      },
    );

    expect(await client.create!()).toBe(session as any);
    expect(await client.resume!(session.state as any)).toBe(session as any);
    await client.delete!(session.state as any);
    expect(order).toEqual(["create", "hydrate", "resume", "delete"]);
  });

  test("keeps exact repository transport URIs in git repo manifest entries", () => {
    const manifest = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://github.com/acme/app.git",
        ref: "main",
      },
    ]);
    expect(manifest.entries["repos/github.com/acme/app.git"]).toMatchObject({
      type: "git_repo",
      repo: "https://github.com/acme/app.git",
      ref: "main",
    });
  });

  test("materializes same-name cross-provider repositories at distinct default paths", () => {
    const manifest = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://github.com/acme/app.git",
        ref: "main",
        provider: "github",
      },
      {
        kind: "repository",
        uri: "https://gitlab.com/acme/app.git",
        ref: "main",
        provider: "gitlab",
      },
      {
        kind: "repository",
        uri: "https://dev.azure.com/acme/project/_git/app",
        ref: "main",
        provider: "azure_devops",
      },
    ]);
    expect(Object.keys(manifest.entries).sort()).toEqual([
      "repos/dev.azure.com/acme/project/_git/app",
      "repos/github.com/acme/app",
      "repos/gitlab.com/acme/app",
    ]);
  });

  test("preserves a custom Git HTTPS port in the manifest remote", () => {
    const manifest = buildManifest(testSettings(), [
      {
        kind: "repository",
        uri: "https://git.example.com:8443/acme/app.git",
        ref: "main",
      },
    ]);
    expect(manifest.entries["repos/git.example.com%3A8443/acme/app.git"]).toMatchObject({
      type: "git_repo",
      repo: "https://git.example.com:8443/acme/app.git",
    });
  });

  test("fails before sandbox execution on case-folded explicit mount collisions", () => {
    const resources = [
      {
        kind: "repository" as const,
        uri: "https://github.com/acme/one.git",
        ref: "main",
        mountPath: "repos/Shared/App",
      },
      {
        kind: "repository" as const,
        uri: "https://gitlab.com/acme/two.git",
        ref: "main",
        mountPath: "repos/shared/app",
      },
    ];
    expect(() => buildManifest(testSettings(), resources)).toThrow(
      "resource mount path is already attached",
    );
    expect(() => repositoryCloneCommand(resources)).toThrow(
      "resource mount path is already attached",
    );
  });

  test("fails before sandbox execution on a repeated identical resource", () => {
    const resource = {
      kind: "repository" as const,
      uri: "https://github.com/acme/app.git",
      ref: "main",
    };
    expect(() => buildManifest(testSettings(), [resource, resource])).toThrow(
      "resource mount path is already attached",
    );
    expect(() => repositoryCloneCommand([resource, resource])).toThrow(
      "resource mount path is already attached",
    );
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
    expect(manifest.entries["repos/github.com/acme/private"]).toMatchObject({
      type: "dir",
    });
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

    expect(manifest.entries["repos/github.com/acme/private"]).toMatchObject({
      type: "dir",
    });
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
    // origin/HEAD is best-effort (branch refs only); a PR ref, tag, or SHA must not
    // fail the clone because `remote set-head` rejects it.
    expect(command).toContain(
      'if git -C "$tmp" rev-parse --verify --quiet "refs/remotes/origin/$ref" >/dev/null; then',
    );
    expect(command).toContain('git -C "$tmp" remote set-head origin "$ref" >/dev/null || true');
    expect(command).toContain('if ! git -C "$tmp" checkout --detach FETCH_HEAD >/dev/null; then');
    expect(command).not.toContain('origin "$ref" && git -C "$tmp" remote set-head');
    expect(command).toContain('git -C "$target" rev-parse --is-inside-work-tree >/dev/null');
    expect(command).toContain("Repository resource ready at $target");
    expect(command).toContain("ensure_git");
    expect(command).toContain("apt-get install -y --no-install-recommends ca-certificates git");
    expect(command).toContain(
      "start_repository_clone '/workspace/repos/github.com/acme/private' 'https://github.com/acme/private.git' 'main' 'packages/api'",
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

  test("runs independent repository clones in bounded batches of four", () => {
    const resources = Array.from({ length: 5 }, (_, index) => ({
      kind: "repository" as const,
      uri: `https://github.com/acme/repo-${index}.git`,
      ref: "main",
    }));
    const command = repositoryCloneCommand(resources);
    const lines = command.split("\n");
    const starts = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.startsWith("start_repository_clone "));
    const waits = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line === "wait_repository_clone_batch");

    expect(starts).toHaveLength(5);
    expect(waits).toHaveLength(2);
    expect(waits[0]!.index).toBeGreaterThan(starts[3]!.index);
    expect(waits[0]!.index).toBeLessThan(starts[4]!.index);
    expect(waits[1]!.index).toBeGreaterThan(starts[4]!.index);
    expect(command).toContain('if ! wait "$clone_pid"; then');
    expect(command).toContain('if [ "$clone_failed" -ne 0 ]; then');
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
    expect(command).toContain(
      'glpat-*) unset GITLAB_ACCESS_TOKEN OAUTH_TOKEN GLAB_IS_OAUTH2; export GITLAB_TOKEN="$token" ;;',
    );
    expect(command).toContain(
      '*) unset GITLAB_TOKEN GITLAB_ACCESS_TOKEN; export OAUTH_TOKEN="$token"; export GLAB_IS_OAUTH2=true ;;',
    );
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

  test("buildOpenGeniAgent requires and exposes the truthful root for selfhosted targets", () => {
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
        sandboxWorkspaceRoot: "/home/user/project",
      }),
    ).not.toThrow();
    const machineAgent = buildOpenGeniAgent(testSettings({ sandboxBackend: "modal" }), resources, {
      activeSandboxBackend: "selfhosted",
      sandboxWorkspaceRoot: "/home/user/project",
    }) as { defaultManifest: { root: string; entries: Record<string, unknown> } };
    expect(machineAgent.defaultManifest.root).toBe("/home/user/project");
    expect(machineAgent.defaultManifest.entries).toEqual({});
    expect(() =>
      buildOpenGeniAgent(testSettings({ sandboxBackend: "modal" }), resources, {
        activeSandboxBackend: "selfhosted",
      }),
    ).toThrow("requires its reported workspace root");
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
          return {
            output: "",
            stdout: "",
            stderr: "",
            wallTimeSeconds: 0,
            exitCode: 0,
          };
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
    expect(cmd.startsWith("set +x\n")).toBe(true);
    expect(cmd.indexOf("set +x")).toBeLessThan(
      cmd.indexOf("export OPENGENI_GIT_GITHUB_TOKEN_SEED="),
    );
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
          return {
            output: "",
            stdout: "",
            stderr: "",
            wallTimeSeconds: 0,
            exitCode: 0,
          };
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
    expect(cmd.startsWith("set +x\n")).toBe(true);
    expect(cmd).toContain("export OPENGENI_GIT_GITLAB_TOKEN_SEED='glpat_liveToken123'");
    expect(cmd).toContain("export OPENGENI_GIT_AZURE_DEVOPS_TOKEN_SEED='azdo_liveToken456'");
    expect(cmd).not.toContain("GITLAB_TOKEN='glpat_liveToken123'");
    expect(cmd).not.toContain("AZURE_DEVOPS_EXT_PAT='azdo_liveToken456'");
  });

  test("smart-Git broker bearer uses private file ingress and never command text", async () => {
    const commands: string[] = [];
    const created: Array<{ path: string; diff: string }> = [];
    const deleted: string[] = [];
    await runRepositoryCloneHook(
      {
        createEditor: () => ({
          createFile: async (operation: { path: string; diff: string }) => {
            created.push(operation);
          },
          updateFile: async () => undefined,
          deleteFile: async (operation: { path: string }) => {
            deleted.push(operation.path);
          },
        }),
        exec: async (args: { cmd: string }) => {
          commands.push(args.cmd);
          return { output: "", stdout: "", stderr: "", wallTimeSeconds: 0, exitCode: 0 };
        },
      } as any,
      [
        {
          kind: "repository",
          uri: "https://github.com/acme/private.git",
          ref: "main",
          provider: "github",
          connectionType: "github_personal",
          credentialBindingId: "personal-binding",
          repositoryId: "9007199254740993123",
          access: "read",
        },
      ],
      {
        environment: { HOME: "/workspace" },
        gitCredentialBindings: [
          {
            credentialBindingId: "personal-binding",
            provider: "github",
            token: "oggh1.secret-broker-bearer",
            transport: {
              kind: "http_broker",
              repositories: [
                {
                  repositoryUri: "https://github.com/acme/private.git",
                  brokerUri: "https://broker.example.test/v1/git/personal/route",
                },
              ],
            },
          },
        ],
      },
    );

    expect(created).toHaveLength(1);
    expect(created[0]!.path).toStartWith("/workspace/.opengeni/git-broker-seeds/");
    expect(created[0]!.diff).toBe("+oggh1.secret-broker-bearer");
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain("oggh1.secret-broker-bearer");
    expect(commands[0]).toContain(created[0]!.path);
    expect(deleted).toEqual([created[0]!.path]);
  });

  test("smart-Git broker bearer attempts cleanup when the editor write outcome is unknown", async () => {
    const created: string[] = [];
    const deleted: string[] = [];

    await expect(
      runRepositoryCloneHook(
        {
          createEditor: () => ({
            createFile: async (operation: { path: string }) => {
              created.push(operation.path);
              throw new Error("response lost after remote write");
            },
            updateFile: async () => undefined,
            deleteFile: async (operation: { path: string }) => {
              deleted.push(operation.path);
            },
          }),
          exec: async () => {
            throw new Error("clone command must not run after an unconfirmed seed write");
          },
        } as any,
        [
          {
            kind: "repository",
            uri: "https://github.com/acme/private.git",
            ref: "main",
            provider: "github",
            connectionType: "github_personal",
            credentialBindingId: "personal-binding",
            repositoryId: "9007199254740993123",
            access: "read",
          },
        ],
        {
          environment: { HOME: "/workspace" },
          gitCredentialBindings: [
            {
              credentialBindingId: "personal-binding",
              provider: "github",
              token: "oggh1.secret-broker-bearer",
              transport: {
                kind: "http_broker",
                repositories: [
                  {
                    repositoryUri: "https://github.com/acme/private.git",
                    brokerUri: "https://broker.example.test/v1/git/personal/route",
                  },
                ],
              },
            },
          ],
        },
      ),
    ).rejects.toThrow("Sandbox could not receive the Git broker credential");

    expect(created).toHaveLength(1);
    expect(deleted).toEqual(created);
  });

  test("smart-Git broker renewal uses the same token-free command boundary", async () => {
    const commands: string[] = [];
    const created: Array<{ path: string; diff: string }> = [];
    await refreshGitCredentialBindingTokenFiles(
      {
        createEditor: () => ({
          createFile: async (operation: { path: string; diff: string }) => {
            created.push(operation);
          },
          updateFile: async () => undefined,
          deleteFile: async () => undefined,
        }),
        exec: async (args: { cmd: string }) => {
          commands.push(args.cmd);
          return { output: "", stdout: "", stderr: "", wallTimeSeconds: 0, exitCode: 0 };
        },
      } as any,
      [
        {
          credentialBindingId: "personal-binding",
          provider: "github",
          token: "oggh1.renewed-secret-bearer",
          transport: {
            kind: "http_broker",
            repositories: [
              {
                repositoryUri: "https://github.com/acme/private.git",
                brokerUri: "https://broker.example.test/v1/git/personal/route",
              },
            ],
          },
        },
      ],
    );

    expect(created[0]!.diff).toBe("+oggh1.renewed-secret-bearer");
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain("oggh1.renewed-secret-bearer");
    expect(commands[0]).toContain(created[0]!.path);
  });

  test("TOKEN-BROKER (B1): with NO seed the clone hook command is byte-for-byte the un-prefixed clone (no-op on selfhosted)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await runRepositoryCloneHook(
      {
        exec: async (args: Record<string, unknown>) => {
          calls.push(args);
          return {
            output: "",
            stdout: "",
            stderr: "",
            wallTimeSeconds: 0,
            exitCode: 0,
          };
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
    expect(String(calls[0]?.cmd).startsWith("set +x\nset -eu")).toBe(true);
  });

  test("CODEMODE-BROKER: seed hook writes the delegated token file from a per-exec prefix only", async () => {
    const command = codemodeTokenSeedCommand();
    expect(command).toContain('if [ -n "${OPENGENI_CODEMODE_TOKEN_SEED:-}" ]; then');
    expect(command).toContain("umask 077");
    expect(command).toContain(
      'token_file="${OPENGENI_CODEMODE_TOKEN_FILE:-$HOME/.opengeni/codemode-token}"',
    );
    expect(command).toContain(
      'printf \'%s\' "$OPENGENI_CODEMODE_TOKEN_SEED" > "$token_file.tmp.$$"',
    );
    expect(command).toContain('mv -f "$token_file.tmp.$$" "$token_file"');

    const calls: Array<Record<string, unknown>> = [];
    await runCodemodeTokenSeedHook(
      {
        exec: async (args: Record<string, unknown>) => {
          calls.push(args);
          return {
            output: "",
            stdout: "",
            stderr: "",
            wallTimeSeconds: 0,
            exitCode: 0,
          };
        },
      } as any,
      {
        environment: {
          HOME: "/workspace",
          OPENGENI_CODEMODE_TOKEN_FILE: "/workspace/.opengeni/codemode-token",
        },
        runAs: "sandbox",
        codemodeTokenSeed: "ogd_codemode_live",
        codemodeTokenFile:
          "/workspace/.opengeni/codemode-tokens/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      } as any,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.environment).toBeUndefined();
    const cmd = String(calls[0]?.cmd);
    expect(cmd.startsWith("set +x\n")).toBe(true);
    expect(cmd).toContain("export OPENGENI_CODEMODE_TOKEN_SEED='ogd_codemode_live'");
    expect(cmd.indexOf("set +x")).toBeLessThan(cmd.indexOf("export OPENGENI_CODEMODE_TOKEN_SEED="));
    expect(cmd.indexOf("export OPENGENI_CODEMODE_TOKEN_SEED=")).toBeLessThan(
      cmd.indexOf("printf '%s' \"$OPENGENI_CODEMODE_TOKEN_SEED\""),
    );
  });

  test("CODEMODE-BROKER: refresh atomically replaces the stable 0600 token file", async () => {
    const home = mkdtempSync(join(tmpdir(), "opengeni-codemode-refresh-"));
    try {
      const session = {
        exec: async (args: { cmd: string }) => {
          const proc = Bun.spawn(["sh", "-lc", args.cmd], {
            cwd: home,
            env: { ...process.env, HOME: home },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          return { exitCode, stdout, stderr };
        },
      };

      await refreshCodemodeTokenFile(session as never, "ogd_renewed");
      const tokenDir = join(home, ".opengeni");
      const tokenFile = join(tokenDir, "codemode-token");
      expect(readFileSync(tokenFile, "utf8")).toBe("ogd_renewed");
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      expect(readdirSync(tokenDir)).toEqual(["codemode-token"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
      repo: "https://github.com/acme/private.git",
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
    expect(Object.keys(applied[0]!.entries)).toEqual(["repos/github.com/acme/two.git"]);
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
        "repos/acme/one": {
          type: "git_repo",
          host: "github.com",
          repo: "acme/one",
          ref: "main",
        },
      },
      environment: { GH_TOKEN: "old-token" },
    });
    const target = new Manifest({
      root: "/workspace",
      entries: {
        "repos/acme/one": {
          type: "git_repo",
          host: "github.com",
          repo: "acme/one",
          ref: "main",
        },
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
          "repos/acme/one": {
            type: "git_repo",
            host: "github.com",
            repo: "acme/one",
            ref: "main",
          },
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
    expect(Object.keys(applied[0]!.entries)).toEqual(["repos/github.com/acme/two.git"]);
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
    expect(materialized).toEqual(["repos/github.com/acme/two.git"]);
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

  test("PrefixedMcpServer preserves the complete legacy callTool result and callToolResult", async () => {
    const fullResult = {
      content: [{ type: "text" as const, text: "model-visible content" }],
      structuredContent: { receiptId: "receipt-1" },
      isError: false,
      _meta: { providerTrace: "trace-1" },
    };
    const inner: MCPServer = {
      name: "rich-inner",
      cacheToolsList: false,
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "inspect",
            description: "Inspect one item.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return fullResult.content;
      },
      async callToolResult() {
        return fullResult;
      },
      async invalidateToolsCache() {},
    };
    const wrapped = new PrefixedMcpServer(inner, "rich");

    expect(await wrapped.callTool("rich__inspect", {})).toEqual(fullResult);
    expect(await wrapped.callToolResult("rich__inspect", {})).toEqual(fullResult);
  });

  test("the Agents SDK preserves prefixed MCP model output and retains the audit result as custom data", async () => {
    const fullResult = {
      content: [{ type: "text" as const, text: "model-visible content" }],
      structuredContent: { receiptId: "receipt-1", structuredOnly: true },
      isError: false,
      _meta: { providerTrace: "trace-1" },
      vendorReceipt: { id: "vendor-receipt-1", committed: true },
    };
    const innerContexts: Array<{
      serverName: string;
      toolName: string;
      arguments: Record<string, unknown> | null;
      resultMeta: Record<string, unknown> | undefined;
      toolOutput: unknown;
    }> = [];
    const inner: MCPServer = {
      name: "rich-inner",
      cacheToolsList: false,
      customDataExtractor: async (context) => {
        innerContexts.push({
          serverName: context.serverName,
          toolName: context.toolName,
          arguments: context.arguments,
          resultMeta: context.resultMeta,
          toolOutput: context.toolOutput,
        });
        return { innerReceipt: "inner-1" };
      },
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "inspect",
            description: "Inspect one item.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return fullResult.content;
      },
      async callToolResult() {
        return fullResult;
      },
      async invalidateToolsCache() {},
    };
    const wrapped = new PrefixedMcpServer(inner, "rich");
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });
    const model = new ScriptedModel([
      {
        output: [scriptedFunctionCall("rich__inspect", {}, "rich-call")],
      },
      { outputText: "done" },
    ]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
      mcpServers: [wrapped],
    });

    const result = await runAgentStream(agent, "Inspect it", settings);
    const streamed: any[] = [];
    for await (const event of result.toStream()) streamed.push(event);
    await result.completed;

    const outputEvent = streamed.find(
      (event) =>
        event.type === "run_item_stream_event" && event.item?.type === "tool_call_output_item",
    );
    expect(outputEvent?.item.output).toEqual(fullResult);
    expect(outputEvent?.item.customData).toEqual({
      [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: fullResult,
      [OPENGENI_INNER_MCP_CUSTOM_DATA_KEY]: { innerReceipt: "inner-1" },
    });
    expect(innerContexts).toEqual([
      {
        serverName: "rich-inner",
        toolName: "inspect",
        arguments: {},
        resultMeta: { providerTrace: "trace-1" },
        toolOutput: fullResult.content[0],
      },
    ]);

    const [durable] = normalizeSdkEvent(outputEvent);
    expect((durable!.payload as { output?: unknown }).output).toEqual(fullResult);

    const secondRequest = JSON.stringify(model.requests[1]?.input);
    expect(secondRequest).toContain("model-visible content");
    expect(secondRequest).toContain("structuredOnly");
    expect(secondRequest).toContain("providerTrace");
    expect(secondRequest).toContain("vendor-receipt-1");
  });

  test("rejects MCP result values the Agents SDK custom-data boundary would rewrite", async () => {
    const bridge = new McpResultCustomDataBridge();

    await expect(
      bridge.captureResult(null, async () => ({
        content: [{ type: "text" as const, text: "negative zero" }],
        structuredContent: { exactValue: -0 },
      })),
    ).rejects.toThrow(
      'Protocol JSON value at $.mcpResult["structuredContent"]["exactValue"] must be a finite number other than negative zero',
    );
  });

  test("releases only the live MCP audit marker after durable event capture", async () => {
    const fullResult = {
      content: [{ type: "text" as const, text: "release after durable capture" }],
      structuredContent: { receiptId: "release-receipt-1" },
      isError: false,
      _meta: { providerTrace: "release-trace-1" },
    };
    const inner: MCPServer = {
      name: "release-inner",
      cacheToolsList: false,
      customDataExtractor: async () => ({ innerReceipt: "retain-inner-1" }),
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "inspect",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return fullResult.content;
      },
      async callToolResult() {
        return fullResult;
      },
      async invalidateToolsCache() {},
    };
    const wrapped = new PrefixedMcpServer(inner, "release");
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });
    const model = new ScriptedModel([
      {
        output: [scriptedFunctionCall("release__inspect", {}, "release-call")],
      },
      { outputText: "done" },
    ]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
      mcpServers: [wrapped],
    });

    const result = await runAgentStream(agent, "Inspect it", settings);
    const streamed: any[] = [];
    for await (const event of result.toStream()) streamed.push(event);
    await result.completed;

    const outputEvent = streamed.find(
      (event) =>
        event.type === "run_item_stream_event" && event.item?.type === "tool_call_output_item",
    );
    const [durable] = normalizeSdkEvent(outputEvent);
    expect((durable!.payload as { output?: unknown }).output).toEqual(fullResult);
    expect(result.state.toString()).toContain(OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY);

    expect(releaseMcpResultCustomDataFromSdkEvent(outputEvent)).toBe(true);
    expect(outputEvent.item.customData).toEqual({
      [OPENGENI_INNER_MCP_CUSTOM_DATA_KEY]: { innerReceipt: "retain-inner-1" },
    });
    expect(result.state.toString()).not.toContain(OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY);
    expect(result.state.toString()).toContain("retain-inner-1");
    expect(releaseMcpResultCustomDataFromSdkEvent(outputEvent)).toBe(false);
  });

  test("nested prefixed servers preserve one exact result marker and the innermost custom data", async () => {
    const observations: Array<Parameters<NonNullable<RuntimeMetricsHooks["onMcpToolCall"]>>[0]> =
      [];
    const lifecycleObservations: Array<
      Parameters<NonNullable<RuntimeMetricsHooks["onMcpLifecycle"]>>[0]
    > = [];
    configureRuntimeMetricsHooks({
      onMcpToolCall: (input) => observations.push(input),
      onMcpLifecycle: (input) => lifecycleObservations.push(input),
    });
    const fullResult = {
      content: [{ type: "text" as const, text: "nested model-visible content" }],
      structuredContent: { receiptId: "nested-receipt-1" },
      isError: false,
      _meta: { providerTrace: "nested-trace-1" },
      vendorReceipt: { id: "nested-vendor-1" },
    };
    const base: MCPServer = {
      name: "nested-base",
      cacheToolsList: false,
      customDataExtractor: async () => ({ baseReceipt: "base-1" }),
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "inspect",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return fullResult.content;
      },
      async callToolResult() {
        return fullResult;
      },
      async invalidateToolsCache() {},
    };
    const inner = new PrefixedMcpServer(base, "inner");
    // The outer registry entry owns effective connection policy. Nested
    // wrappers are a transport implementation detail and must not double-count
    // or report their inner policy as the physical operation's policy.
    const outer = new PrefixedMcpServer(inner, "outer", undefined, true);
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });
    const model = new ScriptedModel([
      {
        output: [scriptedFunctionCall("outer__inner__inspect", {}, "nested-call")],
      },
      { outputText: "done" },
    ]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
      mcpServers: [outer],
    });

    let connected = false;
    try {
      await outer.connect();
      connected = true;
      const result = await runAgentStream(agent, "Inspect it", settings);
      const streamed: any[] = [];
      for await (const event of result.toStream()) streamed.push(event);
      await result.completed;

      const outputEvent = streamed.find(
        (event) =>
          event.type === "run_item_stream_event" && event.item?.type === "tool_call_output_item",
      );
      expect(outputEvent?.item.output).toEqual(fullResult);
      expect(outputEvent?.item.customData).toEqual({
        [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: fullResult,
        [OPENGENI_INNER_MCP_CUSTOM_DATA_KEY]: { baseReceipt: "base-1" },
      });
      expect(observations.map(({ outcome }) => outcome)).toEqual(["success"]);
      await outer.close();
      connected = false;
      expect(
        lifecycleObservations.map(({ phase, policy, outcome }) => ({ phase, policy, outcome })),
      ).toEqual([
        { phase: "connect", policy: "best_effort", outcome: "completed" },
        { phase: "close", policy: "best_effort", outcome: "completed" },
      ]);
    } finally {
      if (connected) await outer.close();
      configureRuntimeMetricsHooks(null);
    }
  });

  test("an ordinary inner extractor may own OpenGeni-looking custom-data keys", async () => {
    const fullResult = {
      content: [{ type: "text" as const, text: "caller-owned marker content" }],
      isError: false,
    };
    const callerOwnedCustomData = {
      [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: { callerOwned: true },
      callerReceipt: "retain-caller-marker",
    };
    const inner: MCPServer = {
      name: "caller-marker-inner",
      cacheToolsList: false,
      customDataExtractor: async () => callerOwnedCustomData,
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "inspect",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return fullResult.content;
      },
      async callToolResult() {
        return fullResult;
      },
      async invalidateToolsCache() {},
    };
    const wrapped = new PrefixedMcpServer(inner, "caller_marker");
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });
    const model = new ScriptedModel([
      {
        output: [scriptedFunctionCall("caller_marker__inspect", {}, "caller-marker-call")],
      },
      { outputText: "done" },
    ]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
      mcpServers: [wrapped],
    });

    const result = await runAgentStream(agent, "Inspect it", settings);
    const streamed: any[] = [];
    for await (const event of result.toStream()) streamed.push(event);
    await result.completed;

    const outputEvent = streamed.find(
      (event) =>
        event.type === "run_item_stream_event" && event.item?.type === "tool_call_output_item",
    );
    expect(outputEvent?.item.customData).toEqual({
      [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: fullResult,
      [OPENGENI_INNER_MCP_CUSTOM_DATA_KEY]: callerOwnedCustomData,
    });
    expect(releaseMcpResultCustomDataFromSdkEvent(outputEvent)).toBe(true);
    expect(outputEvent?.item.customData).toEqual({
      [OPENGENI_INNER_MCP_CUSTOM_DATA_KEY]: callerOwnedCustomData,
    });
  });

  test("a custom server may freeze its clean arguments after a successful call", async () => {
    const fullResult = {
      content: [{ type: "text" as const, text: "frozen arguments accepted" }],
      structuredContent: { receiptId: "frozen-arguments-1" },
      isError: false,
    };
    const receivedArguments: Array<Record<string, unknown> | null> = [];
    const inner: MCPServer = {
      name: "freezing-arguments-inner",
      cacheToolsList: false,
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "commit",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool(_toolName, args) {
        receivedArguments.push(args);
        if (args) Object.freeze(args);
        return fullResult.content;
      },
      async callToolResult(_toolName, args) {
        receivedArguments.push(args);
        if (args) Object.freeze(args);
        return fullResult;
      },
      async invalidateToolsCache() {},
    };
    const wrapped = new PrefixedMcpServer(inner, "freezing_arguments");
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });
    const model = new ScriptedModel([
      {
        output: [
          scriptedFunctionCall(
            "freezing_arguments__commit",
            { value: "committed" },
            "freezing-arguments-call",
          ),
        ],
      },
      { outputText: "done" },
    ]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
      mcpServers: [wrapped],
    });

    const result = await runAgentStream(agent, "Commit it", settings);
    const streamed: any[] = [];
    for await (const event of result.toStream()) streamed.push(event);
    await result.completed;

    const outputEvent = streamed.find(
      (event) =>
        event.type === "run_item_stream_event" && event.item?.type === "tool_call_output_item",
    );
    expect(outputEvent?.item.output).toEqual(fullResult);
    expect(outputEvent?.item.customData).toEqual({
      [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: fullResult,
    });
    expect(receivedArguments).toEqual([{ value: "committed" }]);
    expect(Object.isFrozen(receivedArguments[0])).toBe(true);
  });

  test("the Agents SDK preserves structured-content-only prefixed MCP model output", async () => {
    const fullResult = {
      content: [],
      structuredContent: { structuredOnly: true },
      isError: false,
      _meta: { providerTrace: "structured-only-trace" },
    };
    const inner: MCPServer = {
      name: "structured-only-inner",
      cacheToolsList: false,
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "inspect",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return fullResult.content;
      },
      async callToolResult() {
        return fullResult;
      },
      async invalidateToolsCache() {},
    };
    const wrapped = new PrefixedMcpServer(inner, "structured_only");
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });
    const model = new ScriptedModel([
      {
        output: [scriptedFunctionCall("structured_only__inspect", {}, "structured-call")],
      },
      { outputText: "done" },
    ]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
      mcpServers: [wrapped],
    });

    const result = await runAgentStream(agent, "Inspect it", settings);
    for await (const _event of result.toStream()) {
      // Consume the stream so the second model request is available.
    }
    await result.completed;

    const secondRequest = JSON.stringify(model.requests[1]?.input);
    expect(secondRequest).toContain("structuredOnly");
    expect(secondRequest).toContain("structured-only-trace");
  });

  test("a prefixed server forwards the inner SDK structured-content projection to its extractor", async () => {
    const fullResult = {
      content: [{ type: "text" as const, text: "fallback content" }],
      structuredContent: { receiptId: "structured-receipt-1" },
      isError: false,
    };
    const innerToolOutputs: unknown[] = [];
    const inner: MCPServer = {
      name: "structured-inner",
      cacheToolsList: false,
      useStructuredContent: true,
      customDataExtractor: async (context) => {
        innerToolOutputs.push(context.toolOutput);
        return { retained: true };
      },
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "inspect",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return fullResult.content;
      },
      async callToolResult() {
        return fullResult;
      },
      async invalidateToolsCache() {},
    };
    const wrapped = new PrefixedMcpServer(inner, "structured");
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });
    const model = new ScriptedModel([
      {
        output: [scriptedFunctionCall("structured__inspect", {}, "structured-inner-call")],
      },
      { outputText: "done" },
    ]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
      mcpServers: [wrapped],
    });

    const result = await runAgentStream(agent, "Inspect it", settings);
    for await (const _event of result.toStream()) {
      // Consume the stream so the custom-data extractor runs.
    }
    await result.completed;

    expect(innerToolOutputs).toEqual([JSON.stringify(fullResult.structuredContent)]);
  });

  test("a prefixed inner extractor cannot mutate the retained MCP result", async () => {
    const fullResult = {
      content: [{ type: "text" as const, text: "immutable content" }],
      structuredContent: { receipt: { id: "structured-1" } },
      isError: false,
      _meta: { trace: { id: "trace-1" } },
    };
    const inner: MCPServer = {
      name: "mutating-inner",
      cacheToolsList: false,
      customDataExtractor: async (context) => {
        (context.resultMeta!.trace as { id: string }).id = "mutated-trace";
        (context.structuredContent!.receipt as { id: string }).id = "mutated-structured";
        (context.toolOutput as { text: string }).text = "mutated content";
        return { retained: true };
      },
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "inspect",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return fullResult.content;
      },
      async callToolResult() {
        return fullResult;
      },
      async invalidateToolsCache() {},
    };
    const wrapped = new PrefixedMcpServer(inner, "mutating");
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });
    const model = new ScriptedModel([
      {
        output: [scriptedFunctionCall("mutating__inspect", {}, "mutating-call")],
      },
      { outputText: "done" },
    ]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
      mcpServers: [wrapped],
    });

    const result = await runAgentStream(agent, "Inspect it", settings);
    const streamed: any[] = [];
    for await (const event of result.toStream()) streamed.push(event);
    await result.completed;

    const outputEvent = streamed.find(
      (event) =>
        event.type === "run_item_stream_event" && event.item?.type === "tool_call_output_item",
    );
    expect(outputEvent?.item.output).toEqual(fullResult);
    expect(outputEvent?.item.customData).toEqual({
      [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: fullResult,
      [OPENGENI_INNER_MCP_CUSTOM_DATA_KEY]: { retained: true },
    });
  });

  test("a prefixed inner extractor applies the SDK custom-data normalization boundary", async () => {
    const extractorResults: unknown[] = [{}, { retained: true }, ["invalid"]];
    const inner: MCPServer = {
      name: "normalized-inner",
      cacheToolsList: false,
      customDataExtractor: async () => extractorResults.shift() as Record<string, unknown>,
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "inspect",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return [{ type: "text" as const, text: "content" }];
      },
      async callToolResult() {
        return { content: [{ type: "text" as const, text: "content" }] };
      },
      async invalidateToolsCache() {},
    };
    const wrapped = new PrefixedMcpServer(inner, "normalized");
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });

    const runOnce = async (callId: string) => {
      const model = new ScriptedModel([
        { output: [scriptedFunctionCall("normalized__inspect", {}, callId)] },
        { outputText: "done" },
      ]);
      const agent = buildOpenGeniAgent(settings, [], {
        model,
        hostedWebSearch: false,
        mcpServers: [wrapped],
      });
      const result = await runAgentStream(agent, "Inspect it", settings);
      const streamed: any[] = [];
      for await (const event of result.toStream()) streamed.push(event);
      await result.completed;
      return streamed.find(
        (event) =>
          event.type === "run_item_stream_event" && event.item?.type === "tool_call_output_item",
      );
    };

    const empty = await runOnce("normalized-empty");
    expect(empty?.item.customData).toEqual({
      [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: {
        content: [{ type: "text", text: "content" }],
      },
    });
    const retained = await runOnce("normalized-retained");
    expect(retained?.item.customData).toEqual({
      [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: {
        content: [{ type: "text", text: "content" }],
      },
      [OPENGENI_INNER_MCP_CUSTOM_DATA_KEY]: { retained: true },
    });
    await expect(runOnce("normalized-invalid")).rejects.toThrow(
      "customDataExtractor must return an object or null.",
    );
  });

  test("a prefixed inner extractor mirrors the SDK sparse-array JSON boundary", async () => {
    const sparse = new Array(2);
    const inner: MCPServer = {
      name: "sparse-inner",
      cacheToolsList: false,
      customDataExtractor: async () => ({ sparse }),
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "inspect",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return [{ type: "text" as const, text: "content" }];
      },
      async callToolResult() {
        return { content: [{ type: "text" as const, text: "content" }] };
      },
      async invalidateToolsCache() {},
    };
    const wrapped = new PrefixedMcpServer(inner, "sparse");
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });
    const model = new ScriptedModel([
      { output: [scriptedFunctionCall("sparse__inspect", {}, "sparse-call")] },
      { outputText: "done" },
    ]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
      mcpServers: [wrapped],
    });

    const result = await runAgentStream(agent, "Inspect it", settings);
    const streamed: any[] = [];
    for await (const event of result.toStream()) streamed.push(event);
    await result.completed;

    const outputEvent = streamed.find(
      (event) =>
        event.type === "run_item_stream_event" && event.item?.type === "tool_call_output_item",
    );
    expect(outputEvent?.item.customData).toEqual({
      [OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]: {
        content: [{ type: "text", text: "content" }],
      },
      [OPENGENI_INNER_MCP_CUSTOM_DATA_KEY]: { sparse: [null, null] },
    });
  });

  test("approval RunState compaction removes only the redundant MCP result marker", async () => {
    const largeText = "x".repeat(1_047_000);
    const fullResult = {
      content: [{ type: "text" as const, text: largeText }],
      isError: false,
      _meta: { providerTrace: "large-trace-1" },
    };
    const inner: MCPServer = {
      name: "large-inner",
      cacheToolsList: false,
      customDataExtractor: async () => ({ innerReceipt: "keep-me" }),
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "inspect",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "mutate",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool(toolName) {
        return toolName === "inspect"
          ? fullResult.content
          : [{ type: "text" as const, text: "mutated" }];
      },
      async callToolResult(toolName) {
        return toolName === "inspect"
          ? fullResult
          : { content: [{ type: "text" as const, text: "mutated" }] };
      },
      async invalidateToolsCache() {},
    };
    const wrapped = new PrefixedMcpServer(inner, "large");
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
      mcpServers: [
        {
          id: "large",
          name: "Large result",
          url: "https://large.invalid/mcp",
          cacheToolsList: false,
          requireApproval: ["mutate"],
        },
      ],
    });
    const model = new ScriptedModel([
      {
        output: [
          scriptedFunctionCall("large__inspect", {}, "large-inspect-call"),
          scriptedFunctionCall("large__mutate", {}, "large-mutate-call"),
        ],
      },
    ]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
      mcpServers: [wrapped],
    });

    const result = await runAgentStream(agent, "Inspect then mutate", settings);
    for await (const _event of result.toStream()) {
      // Drain the completed inspect result before the approval interruption.
    }
    await result.completed;
    expect(result.interruptions).toHaveLength(1);

    const serialized = result.state.toString();
    expect(serialized).toContain(OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY);
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(3 * 1024 * 1024);

    const compacted = compactMcpResultCustomDataRunState(serialized);
    expect(compacted).not.toContain(OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY);
    expect(compacted).toContain(OPENGENI_INNER_MCP_CUSTOM_DATA_KEY);
    expect(compacted).toContain("keep-me");
    expect(compacted).toContain("large-trace-1");
    expect(Buffer.byteLength(compacted, "utf8")).toBeLessThan(3 * 1024 * 1024);

    const resumed = await RunState.fromString(agent, compacted);
    expect(resumed.getInterruptions()).toHaveLength(1);
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
        prepared.mcpServers[0]!.callTool("docs__fetch_document", {
          id: "doc-1",
        }),
      ).rejects.toThrow("not allowed");
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("preserves HTTP-200 MCP errors through the SDK and meters bounded structural outcomes", async () => {
    const observations: Array<Parameters<NonNullable<RuntimeMetricsHooks["onMcpToolCall"]>>[0]> =
      [];
    configureRuntimeMetricsHooks({
      onMcpToolCall: (input) => observations.push(input),
    });
    const providerOnlyErrorMarker = "provider-only-http-200-error-marker";
    const mcp = startTestMcpServer({
      toolResultIsError: true,
      toolResultText: providerOnlyErrorMarker,
    });
    const prepared = await prepareAgentTools(
      testSettings({
        sandboxBackend: "none",
        webSearchEnabled: false,
        mcpServers: [
          {
            id: "http_error",
            name: "HTTP error result",
            url: mcp.url,
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "http_error" }],
    );
    try {
      const [httpErrorTool] = await prepared.mcpServers[0]!.listTools();
      expect(httpErrorTool?.name).toBe("http_error__search_documents");
      const settings = testSettings({
        sandboxBackend: "none",
        webSearchEnabled: false,
      });
      const model = new ScriptedModel([
        {
          output: [
            scriptedFunctionCall(
              httpErrorTool!.name,
              { query: "failed delivery" },
              "http-error-call",
            ),
          ],
        },
        { outputText: "done" },
      ]);
      const agent = buildOpenGeniAgent(settings, [], {
        model,
        hostedWebSearch: false,
        mcpServers: prepared.mcpServers,
      });

      const result = await runAgentStream(agent, "Inspect it", settings);
      const streamed: any[] = [];
      for await (const event of result.toStream()) streamed.push(event);
      await result.completed;

      const outputEvent = streamed.find(
        (event) =>
          event.type === "run_item_stream_event" && event.item?.type === "tool_call_output_item",
      );
      expect(outputEvent?.item.output).toMatchObject({
        isError: true,
        content: [{ type: "text", text: providerOnlyErrorMarker }],
      });
      const [durable] = normalizeSdkEvent(outputEvent);
      expect((durable!.payload as { output?: unknown }).output).toEqual(outputEvent.item.output);
      const nextModelInput = model.requests[1]?.input;
      expect(Array.isArray(nextModelInput)).toBe(true);
      const nextModelToolResult = (nextModelInput as any[]).find(
        (item) => item.type === "function_call_result" && item.callId === "http-error-call",
      );
      expect(JSON.parse(nextModelToolResult.output.text)).toMatchObject({
        isError: true,
        content: [{ type: "text", text: providerOnlyErrorMarker }],
      });

      const scriptedResults: unknown[] = [
        { content: [{ type: "text", text: "ok" }] },
        Object.assign(
          new Error("Authentication required - a connection link was posted to the session."),
          { code: 40_101 },
        ),
        Object.assign(new Error("outcome uncertain"), {
          code: 40_102,
          data: { providerFailure: { body: "unknown provider outcome" } },
        }),
        Object.assign(new Error("MCP error -32001: Request timed out"), {
          code: ErrorCode.RequestTimeout,
        }),
        Object.assign(new Error("cancelled"), { name: "AbortError" }),
        Object.assign(new Error("upstream unavailable"), { status: 503 }),
        Object.assign(new Error("application-defined protocol failure"), { code: 503 }),
        Object.assign(new Error("MCP error -32602: Invalid params"), {
          code: ErrorCode.InvalidParams,
        }),
        new McpError(ErrorCode.ConnectionClosed, "application-defined protocol failure"),
      ];
      const structural = new PrefixedMcpServer(
        {
          name: "structural-outcomes",
          cacheToolsList: false,
          async connect() {},
          async close() {},
          async listTools() {
            return [];
          },
          async callTool() {
            return [];
          },
          async callToolResult() {
            const next = scriptedResults.shift();
            if (next instanceof Error) throw next;
            return next;
          },
          async invalidateToolsCache() {},
        },
        "structural-outcomes",
        undefined,
        true,
      );
      const structuralResults: unknown[] = [];
      for (let index = 0; index < 9; index += 1) {
        structuralResults.push(await structural.executeCatalogTool("inspect", {}));
      }

      expect(structuralResults[2]).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "tool_outcome_unknown",
            retryable: false,
            outcomeUnknown: true,
          },
        },
      });

      expect(observations.map(({ outcome }) => outcome)).toEqual([
        "provider_declared_error",
        "success",
        "auth_needed",
        "outcome_uncertain",
        "timeout",
        "cancelled",
        "thrown_transport_error",
        "thrown_protocol_error",
        "thrown_protocol_error",
        "thrown_protocol_error",
      ]);
      expect(observations.every(({ durationSeconds }) => durationSeconds >= 0)).toBe(true);
    } finally {
      configureRuntimeMetricsHooks(null);
      await prepared.close();
      mcp.close();
    }
  });

  test("bounds direct gateway execution results before adapter projection", async () => {
    const oversizedResult = new PrefixedMcpServer(
      {
        name: "oversized-direct-gateway-result",
        cacheToolsList: false,
        async connect() {},
        async close() {},
        async listTools() {
          return [];
        },
        async callTool() {
          return [];
        },
        async callToolResult() {
          return {
            content: [
              {
                type: "text",
                text: "x".repeat(MCP_MAX_TOOL_RESULT_BYTES + 1),
              },
            ],
          };
        },
        async invalidateToolsCache() {},
      },
      "oversized-direct-gateway-result",
    );

    await expect(oversizedResult.executeCatalogTool("inspect", {})).rejects.toThrow(
      "MCP tool result exceeds the 1048576-byte safety limit",
    );

    const oversizedUncertainOutcome = new PrefixedMcpServer(
      {
        name: "oversized-uncertain-gateway-result",
        cacheToolsList: false,
        async connect() {},
        async close() {},
        async listTools() {
          return [];
        },
        async callTool() {
          return [];
        },
        async callToolResult() {
          throw Object.assign(new Error("outcome uncertain"), {
            code: 40_102,
            data: {
              providerFailure: { body: "x".repeat(MCP_MAX_TOOL_RESULT_BYTES + 1) },
            },
          });
        },
        async invalidateToolsCache() {},
      },
      "oversized-uncertain-gateway-result",
    );
    await expect(oversizedUncertainOutcome.executeCatalogTool("inspect", {})).rejects.toThrow(
      "MCP tool result exceeds the 1048576-byte safety limit",
    );
  });

  test("preserves generated integration outcome uncertainty across best-effort isolation", async () => {
    const observations: Array<Parameters<NonNullable<RuntimeMetricsHooks["onMcpToolCall"]>>[0]> =
      [];
    configureRuntimeMetricsHooks({
      onMcpToolCall: (input) => observations.push(input),
    });
    const sourceFailure = new IntegrationInvocationError(
      "request_failed",
      "Integration request failed",
      "unknown",
      false,
    );
    const server: MCPServer = {
      name: "generated-integration-outcome-unknown",
      cacheToolsList: false,
      async connect() {},
      async close() {},
      async listTools() {
        return [];
      },
      async callTool() {
        throw sourceFailure;
      },
      async callToolResult() {
        throw sourceFailure;
      },
      async invalidateToolsCache() {},
    };
    try {
      for (const bestEffort of [false, true]) {
        const prefixed = new PrefixedMcpServer(
          server,
          bestEffort ? "generated-best-effort" : "generated-required",
          undefined,
          bestEffort,
        );
        let caught: unknown;
        try {
          await prefixed.executeCatalogTool("mutate", {});
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(sourceFailure);
      }
      expect(observations.map(({ outcome }) => outcome)).toEqual([
        "outcome_uncertain",
        "outcome_uncertain",
      ]);
    } finally {
      configureRuntimeMetricsHooks(null);
    }
  });

  test("MCP outcome metrics and projections cannot replace hostile source failures", async () => {
    const observations: Array<Parameters<NonNullable<RuntimeMetricsHooks["onMcpToolCall"]>>[0]> =
      [];
    configureRuntimeMetricsHooks({
      onMcpToolCall: (input) => observations.push(input),
    });

    const withHostileProperty = (property: "name" | "code" | "message", label: string) => {
      const error = new Error(`${label} source failure`);
      Object.defineProperty(error, property, {
        configurable: true,
        get() {
          throw new Error(`hostile ${property} getter`);
        },
      });
      return error;
    };
    const fixtures: Array<{ error: unknown; expectedBestEffortText: string }> = [
      {
        error: withHostileProperty("name", "name"),
        expectedBestEffortText: "name source failure",
      },
      {
        error: withHostileProperty("code", "code"),
        expectedBestEffortText: "code source failure",
      },
      {
        error: withHostileProperty("message", "message"),
        expectedBestEffortText: "MCP tool call failed",
      },
      {
        error: new Proxy(new Error("proxy source failure"), {
          getPrototypeOf() {
            throw new Error("hostile proxy getPrototypeOf");
          },
        }),
        expectedBestEffortText: "MCP tool call failed",
      },
    ];
    const serverFor = (error: unknown): MCPServer => ({
      name: "hostile-error",
      cacheToolsList: false,
      async connect() {},
      async close() {},
      async listTools() {
        return [];
      },
      async callTool() {
        throw error;
      },
      async callToolResult() {
        throw error;
      },
      async invalidateToolsCache() {},
    });
    try {
      for (const [index, fixture] of fixtures.entries()) {
        const required = new PrefixedMcpServer(
          serverFor(fixture.error),
          `hostile-required-${index}`,
        );
        const bestEffort = new PrefixedMcpServer(
          serverFor(fixture.error),
          `hostile-best-effort-${index}`,
          undefined,
          true,
        );
        let requiredFailure: unknown;
        try {
          await required.executeCatalogTool("inspect", {});
        } catch (error) {
          requiredFailure = error;
        }
        expect(requiredFailure).toBe(fixture.error);

        const bestEffortResult = await bestEffort.executeCatalogTool("inspect", {});
        expect(bestEffortResult.isError).toBe(true);
        expect(bestEffortResult.content[0]).toEqual({
          type: "text",
          text: fixture.expectedBestEffortText,
        });
      }
      expect(observations.map(({ outcome }) => outcome)).toEqual(
        Array.from({ length: fixtures.length * 2 }, () => "thrown_protocol_error"),
      );
    } finally {
      configureRuntimeMetricsHooks(null);
    }
  });

  test("classifies an SDK connection closure as transport without replacing the source failure", async () => {
    const observations: Array<Parameters<NonNullable<RuntimeMetricsHooks["onMcpToolCall"]>>[0]> =
      [];
    configureRuntimeMetricsHooks({
      onMcpToolCall: (input) => observations.push(input),
    });

    const sourceFailure = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    const server: MCPServer = {
      name: "connection-closed",
      cacheToolsList: false,
      async connect() {},
      async close() {},
      async listTools() {
        return [];
      },
      async callTool() {
        throw sourceFailure;
      },
      async callToolResult() {
        throw sourceFailure;
      },
      async invalidateToolsCache() {},
    };
    const required = new PrefixedMcpServer(server, "connection-closed-required");
    const bestEffort = new PrefixedMcpServer(
      server,
      "connection-closed-best-effort",
      undefined,
      true,
    );

    try {
      let requiredFailure: unknown;
      try {
        await required.executeCatalogTool("inspect", {});
      } catch (error) {
        requiredFailure = error;
      }
      expect(requiredFailure).toBe(sourceFailure);

      const bestEffortResult = await bestEffort.executeCatalogTool("inspect", {});
      expect(bestEffortResult.isError).toBe(true);
      expect(bestEffortResult.content[0]).toEqual({
        type: "text",
        text: sourceFailure.message,
      });
      expect(observations.map(({ outcome }) => outcome)).toEqual([
        "thrown_transport_error",
        "thrown_transport_error",
      ]);
    } finally {
      configureRuntimeMetricsHooks(null);
    }
  });

  test("freezes one exact catalog and routes model MCP and Codemode through one executor", async () => {
    const mcp = startTestMcpServer();
    let persistedDigest: string | null = null;
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "docs",
            name: "Document Search",
            url: mcp.url,
            cacheToolsList: false,
            requireApproval: ["fetch_document"],
          },
        ],
      }),
      [{ kind: "mcp", id: "docs" }],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        onAttemptToolCatalog: (catalog) => {
          persistedDigest = catalog.digest;
        },
      },
    );
    try {
      expect(prepared.attemptToolCatalog?.entries).toEqual([
        expect.objectContaining({
          identity: { serverId: "docs", toolName: "search_documents" },
          modelName: "docs__search_documents",
          codemodePath: ["docs", "search_documents"],
          source: "docs",
          approval: "none",
        }),
        expect.objectContaining({
          identity: { serverId: "docs", toolName: "fetch_document" },
          approval: "human",
        }),
      ]);
      expect(persistedDigest).toBe(prepared.attemptToolCatalog?.digest ?? null);

      const modelResult = await prepared.mcpServers[0]!.callTool("docs__search_documents", {
        query: "model",
      });
      expect(JSON.stringify(modelResult)).toContain("found document for model");
      const environment = prepared.attemptToolEnvironment!;
      const codemodeResult = await environment.call({
        operationId: "66666666-6666-4666-8666-666666666666",
        catalogDigest: environment.catalog.digest,
        identity: { serverId: "docs", toolName: "search_documents" },
        arguments: { query: "codemode" },
        caller: { kind: "codemode", subjectId: "agent:test" },
      });
      expect(JSON.stringify(codemodeResult)).toContain("found document for codemode");
      await expect(
        environment.call({
          operationId: "77777777-7777-4777-8777-777777777777",
          catalogDigest: environment.catalog.digest,
          identity: { serverId: "docs", toolName: "fetch_document" },
          arguments: { id: "doc-1" },
          caller: { kind: "codemode", subjectId: "agent:test" },
        }),
      ).rejects.toMatchObject({ code: "approval_required" });
      expect(mcp.calls).toEqual([
        { tool: "search_documents", args: { query: "model" } },
        { tool: "search_documents", args: { query: "codemode" } },
      ]);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("retains full MCP output and effect metadata in the frozen catalog", async () => {
    const mcp = startTestMcpServer({ richToolMetadata: true });
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "docs",
            name: "Document Search",
            url: mcp.url,
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "docs" }],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
      },
    );
    try {
      const entry = prepared.attemptToolCatalog?.entries.find(
        ({ identity }) => identity.toolName === "summarize_document",
      );
      expect(entry).toMatchObject({
        title: "Summarize document",
        outputSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            sourceId: { type: "string" },
          },
          required: ["summary", "sourceId"],
        },
        annotations: {
          title: "Document summary",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
      const result = await prepared.attemptToolEnvironment!.call({
        operationId: "88888888-8888-4888-8888-888888888888",
        catalogDigest: prepared.attemptToolCatalog!.digest,
        identity: { serverId: "docs", toolName: "summarize_document" },
        arguments: { id: "doc-1" },
        caller: { kind: "codemode", subjectId: "agent:test" },
      });
      expect(result.structuredContent).toEqual({
        summary: "summary for doc-1",
        sourceId: "doc-1",
      });
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("projects in-process definitions through the same model and Codemode authority", async () => {
    const executions: string[] = [];
    const prepared = await prepareAgentTools(testSettings(), [], {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 1,
      attemptToolDefinitions: [
        {
          identity: { serverId: "interaction", toolName: "browser_observe" },
          modelName: "interaction__browser_observe",
          codemodePath: ["interaction", "browser", "observe"],
          title: "Observe browser",
          description: "Observe one exact browser target.",
          inputSchema: {
            type: "object",
            properties: { targetId: { type: "string" } },
            required: ["targetId"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { observationId: { type: "string" } },
            required: ["observationId"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, idempotentHint: true },
          source: "interaction",
          approval: "none",
          execute: async (args, context) => {
            executions.push(`${context.caller.kind}:${String(args.targetId)}`);
            return {
              content: [{ type: "text", text: "observation-1" }],
              structuredContent: { observationId: "observation-1" },
            };
          },
        },
      ],
    });
    try {
      expect(prepared.mcpServers).toHaveLength(1);
      expect(await prepared.mcpServers[0]!.listTools()).toEqual([
        expect.objectContaining({
          name: "interaction__browser_observe",
          title: "Observe browser",
          outputSchema: expect.any(Object),
          annotations: { readOnlyHint: true, idempotentHint: true },
        }),
      ]);
      expect(prepared.attemptToolCatalog?.entries).toEqual([
        expect.objectContaining({
          identity: { serverId: "interaction", toolName: "browser_observe" },
          codemodePath: ["interaction", "browser", "observe"],
          source: "interaction",
        }),
      ]);
      expect(
        await prepared.mcpServers[0]!.callToolResult?.("interaction__browser_observe", {
          targetId: "tab-1",
        }),
      ).toMatchObject({
        structuredContent: { observationId: "observation-1" },
      });
      expect(
        await prepared.attemptToolEnvironment!.call({
          operationId: "99999999-9999-4999-8999-999999999999",
          catalogDigest: prepared.attemptToolCatalog!.digest,
          identity: { serverId: "interaction", toolName: "browser_observe" },
          arguments: { targetId: "tab-2" },
          caller: { kind: "codemode", subjectId: "agent:test" },
        }),
      ).toMatchObject({
        structuredContent: { observationId: "observation-1" },
      });
      expect(executions).toEqual(["model:tab-1", "codemode:tab-2"]);
    } finally {
      await prepared.close();
    }
  });

  test("includes every model-visible MCP and in-process tool in Codemode exactly once", async () => {
    const mcp = startTestMcpServer();
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "docs",
            name: "Document Search",
            url: mcp.url,
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "docs" }],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        attemptToolDefinitions: [
          {
            identity: { serverId: "interaction", toolName: "browser_observe" },
            modelName: "interaction__browser_observe",
            codemodePath: ["interaction", "browser", "observe"],
            inputSchema: { type: "object", additionalProperties: false },
            source: "interaction",
            approval: "none",
            execute: async () => ({ content: [] }),
          },
        ],
      },
    );
    try {
      const modelNames = (
        await Promise.all(prepared.mcpServers.map(async (server) => await server.listTools()))
      )
        .flat()
        .map((tool) => tool.name)
        .sort();
      const catalogNames = prepared
        .attemptToolCatalog!.entries.map((entry) => entry.modelName)
        .sort();
      expect(catalogNames).toEqual(modelNames);
      expect(new Set(catalogNames).size).toBe(catalogNames.length);
      expect(prepared.attemptToolCatalog!.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identity: { serverId: "docs", toolName: "search_documents" },
            source: "docs",
          }),
          expect.objectContaining({
            identity: { serverId: "interaction", toolName: "browser_observe" },
            source: "interaction",
          }),
        ]),
      );
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("rejects in-process definitions without exact attempt scope", async () => {
    await expect(
      prepareAgentTools(testSettings(), [], {
        attemptToolDefinitions: [
          {
            identity: { serverId: "interaction", toolName: "discover" },
            modelName: "interaction__discover",
            inputSchema: { type: "object", additionalProperties: false },
            source: "interaction",
            approval: "none",
            execute: async () => ({ content: [] }),
          },
        ],
      }),
    ).rejects.toThrow("exact attempt scope");
  });

  test("sends the shared access key to first-party MCP servers", async () => {
    const accessKey = "local-mcp-access-key";
    const mcp = startTestMcpServer({
      requiredHeaders: { "x-opengeni-access-key": accessKey },
    });
    const prepared = await prepareAgentTools(
      testSettings({
        authRequired: true,
        accessKey,
        opengeniMcpInternalUrl: mcp.url,
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
          opengeniMcpInternalUrl: `${mcp.url}?ws={workspaceId}`,
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
          sessionId: "33333333-3333-4333-8333-333333333333",
          turnId: "44444444-4444-4444-8444-444444444444",
          attemptId: "55555555-5555-4555-8555-555555555555",
          executionGeneration: 1,
        },
      );
      try {
        // T0: connect + first list — bearer minted with exp = T0 + 1h.
        const first = await prepared.mcpServers[0]!.listTools();
        expect(first.map((t) => t.name)).toContain("opengeni__search_documents");
        const expsAfterFirst = seenExps.length;
        // Fast-forward 2h — any bearer minted at connect is now expired.
        nowMs += 2 * 60 * 60 * 1000;
        // The attempt catalog is frozen, so re-list is deliberately local. A
        // real tool request still re-signs at the transport boundary.
        const second = await prepared.mcpServers[0]!.listTools();
        expect(second.map((t) => t.name)).toContain("opengeni__search_documents");
        const toolResult = await prepared.mcpServers[0]!.callTool("opengeni__search_documents", {
          query: "fresh bearer",
        });
        expect(JSON.stringify(toolResult)).toContain("found document for fresh bearer");
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

  test("signs an explicit empty first-party tool selection without default widening", async () => {
    const seenSelections: unknown[] = [];
    const seenPrincipalKinds: unknown[] = [];
    const mcp = startTestMcpServer({
      validateAuthorization: async (authorization) => {
        if (!authorization?.startsWith("Bearer ")) return false;
        const payload = await verifyDelegatedAccessToken(
          "test-delegation-secret",
          authorization.slice("Bearer ".length),
        );
        if (!payload) return false;
        seenSelections.push(payload.firstPartyMcpTools);
        seenPrincipalKinds.push(payload.principalKind);
        return true;
      },
    });
    const prepared = await prepareAgentTools(
      testSettings({
        opengeniMcpInternalUrl: `${mcp.url}?ws={workspaceId}`,
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
        firstPartyTools: [],
      },
    );
    try {
      await prepared.mcpServers[0]!.listTools();
      expect(seenSelections.length).toBeGreaterThan(0);
      expect(seenSelections.every((selection) => JSON.stringify(selection) === "[]")).toBe(true);
      expect(seenPrincipalKinds.every((kind) => kind === "service")).toBe(true);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("signs trusted nested-agent depth facts into each agent-attempt bearer", async () => {
    const seenDepths: Array<[number | undefined, number | undefined]> = [];
    const mcp = startTestMcpServer({
      validateAuthorization: async (authorization) => {
        if (!authorization?.startsWith("Bearer ")) return false;
        const payload = await verifyDelegatedAccessToken(
          "test-delegation-secret",
          authorization.slice("Bearer ".length),
        );
        if (!payload) return false;
        seenDepths.push([payload.nestedAgentDepth, payload.effectiveMaxNestedAgentDepth]);
        return true;
      },
    });
    const prepared = await prepareAgentTools(
      testSettings({
        opengeniMcpInternalUrl: `${mcp.url}?ws={workspaceId}`,
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
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        nestedAgentDepth: 3,
        effectiveMaxNestedAgentDepth: 3,
      },
    );
    try {
      await prepared.mcpServers[0]!.listTools();
      expect(seenDepths.length).toBeGreaterThan(0);
      expect(seenDepths.every((value) => value[0] === 3 && value[1] === 3)).toBe(true);
    } finally {
      await prepared.close();
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
            opengeniMcpInternalUrl: `${mcp.url}?ws={workspaceId}`,
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
            sessionId: "33333333-3333-4333-8333-333333333333",
            turnId: "44444444-4444-4444-8444-444444444444",
            attemptId: "55555555-5555-4555-8555-555555555555",
            executionGeneration: 1,
          },
        ),
      ).rejects.toThrow();
    } finally {
      mcp.close();
    }
  });

  test("degrades a subject-owned MCP without human authority instead of failing the turn", async () => {
    let resolverCalls = 0;
    const transportCalls: Array<{
      input: string | URL | Request;
      init?: RequestInit;
    }> = [];
    const authNeeded: ToolAuthNeededPayload[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "personal-slack",
            name: "Personal Slack",
            url: "https://mcp.slack.com/mcp",
            connectionRef: {
              providerDomain: "slack.com",
              kind: "oauth2",
              subjectScope: "subject",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "personal-slack", optional: true }],
      {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        resolveCredential: async (request) => {
          resolverCalls += 1;
          expect(request.subjectId).toBeUndefined();
          return {
            status: "auth_needed",
            reason: "missing_connection",
            providerDomain: "slack.com",
          };
        },
        onAuthNeeded: (payload) => authNeeded.push(payload),
        mcpFetchImpl: async (input, init) => {
          transportCalls.push({ input, init });
          throw new Error("credential-free request must not reach the transport");
        },
      },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(0);
      expect(transportCalls).toEqual([]);
      expect(resolverCalls).toBeGreaterThan(0);
      expect(authNeeded).toEqual([]);
    } finally {
      await prepared.close();
    }
  });

  test("routes every official-Gmail turn through the REST bridge, never the hosted preview MCP", async () => {
    const resolved: ResolveConnectionCredentialInput[] = [];
    const fetched: string[] = [];
    const connectorActionPolicy: ConnectorActionPolicyHooks = {
      prepare: async () => ({ managed: false, decision: "unmanaged" }),
      begin: async () => ({ allowed: true, managed: false }),
      complete: async () => {},
    };
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "gmail",
            name: "Gmail",
            url: "https://gmailmcp.googleapis.com/mcp/v1",
            allowedTools: ["list_labels"],
            requireApproval: ["create_draft"],
            connectionRef: {
              providerDomain: "gmailmcp.googleapis.com",
              kind: "oauth2",
              subjectScope: "subject",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "gmail" }],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        connectorActionPolicy,
        credentialSubjectId: "subject-a",
        resolveCredential: async (input) => {
          resolved.push(input);
          return {
            status: "ok",
            connectionId: "gmail-connection",
            headers: { authorization: "Bearer gmail-token" },
          };
        },
        mcpFetchImpl: async (input) => {
          fetched.push(input.toString());
          return Response.json({
            labels: [{ id: "Label_1", name: "Projects", type: "user" }],
          });
        },
      },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(1);
      expect((await prepared.mcpServers[0]!.listTools()).map((tool) => tool.name)).toEqual([
        "gmail__list_labels",
      ]);
      const result = await prepared.mcpServers[0]!.callTool("gmail__list_labels", {});
      expect(JSON.stringify(result)).toContain("Projects");
      const codemodeResult = await prepared.attemptToolEnvironment!.call({
        operationId: "66666666-6666-4666-8666-666666666666",
        catalogDigest: prepared.attemptToolCatalog!.digest,
        identity: { serverId: "gmail", toolName: "list_labels" },
        arguments: {},
        caller: { kind: "codemode", subjectId: "agent:test" },
      });
      expect(JSON.stringify(codemodeResult)).toContain("Projects");
      expect(fetched).toEqual([
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      ]);
      expect(resolved).toHaveLength(3);
      expect(resolved[1]).toMatchObject({
        workspaceId: "22222222-2222-4222-8222-222222222222",
        subjectId: "subject-a",
        serverId: "gmail",
        toolName: "list_labels",
        destinationUrl: "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      });
      expect(resolved[2]).toMatchObject({
        subjectId: "subject-a",
        serverId: "gmail",
        toolName: "list_labels",
      });
      expect(prepared.resolvedMcpConnectionIds.get("gmail")).toBe("gmail-connection");
    } finally {
      await prepared.close();
    }
  });

  test("sends configured credential headers to third-party MCP servers", async () => {
    const mcp = startTestMcpServer({
      requiredHeaders: { "x-api-key": "capability-credential" },
    });
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
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer broker-token" },
    });
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
          return {
            status: "ok",
            connectionId,
            headers: { authorization: "Bearer broker-token" },
          };
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

  test("retries replay-safe brokered MCP requests once after 401 with a forced refresh", async () => {
    const connectionId = "33333333-3333-4333-8333-333333333333";
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer fresh-token" },
    });
    const resolved: ResolveConnectionCredentialInput[] = [];
    let providerAuthorizations = 0;
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
            authorizeProviderRequest: async () => {
              providerAuthorizations += 1;
              return true;
            },
          };
        },
      },
    );
    try {
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toContain("cap-refresh__search_documents");
      expect(resolved.some((input) => input.forceRefresh === true)).toBe(true);
      expect(providerAuthorizations).toBe(mcp.requests.length);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("retains successful host provenance when a replay-safe request still 401s after refresh", async () => {
    const connectionId = "legacy-host-binding";
    const mcp = startTestMcpServer();
    const authNeeded: ToolAuthNeededPayload[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "host-refresh-failed",
            name: "Legacy host binding",
            url: mcp.url,
            connectionRef: {
              connectionId,
              providerDomain: "host.example.test",
              kind: "delegated",
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "host-refresh-failed" }],
      {
        workspaceId: "44444444-4444-4444-8444-444444444444",
        resolveCredential: async (): Promise<ResolveConnectionCredentialResult> => ({
          status: "ok",
          authoritySource: "host",
          connectionId,
          headers: { authorization: "Bearer host-token" },
        }),
        onAuthNeeded: (payload) => authNeeded.push(payload),
        mcpFetchImpl: async (input, init) => {
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
          if (body?.method === "tools/list") {
            return new Response("unauthorized", { status: 401 });
          }
          return await globalThis.fetch(input, init);
        },
      },
    );
    try {
      expect(await prepared.mcpServers[0]!.listTools()).toEqual([]);
      expect(authNeeded).toContainEqual(
        expect.objectContaining({
          serverId: "host-refresh-failed",
          providerDomain: "host.example.test",
          connectionId,
          authoritySource: "host",
          reason: "expired",
        }),
      );
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("never replays brokered tools/call after 401 and reports an uncertain outcome", async () => {
    const connectionId = "34343434-3434-4434-8434-343434343434";
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer fresh-token" },
    });
    const resolved: ResolveConnectionCredentialInput[] = [];
    let providerAuthorizations = 0;
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "cap-uncertain",
            name: "Uncertain capability MCP",
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
      [{ kind: "mcp", id: "cap-uncertain" }],
      {
        workspaceId: "45454545-4545-4545-8545-454545454545",
        resolveCredential: async (input): Promise<ResolveConnectionCredentialResult> => {
          resolved.push(input);
          return {
            status: "ok",
            connectionId,
            headers: {
              authorization: input.forceRefresh ? "Bearer fresh-token" : "Bearer stale-token",
            },
            authorizeProviderRequest: async () => {
              providerAuthorizations += 1;
              return true;
            },
          };
        },
      },
    );
    try {
      const setupAuthorizations = providerAuthorizations;
      const result = await prepared.mcpServers[0]!.callToolResult!(
        "cap-uncertain__search_documents",
        {
          query: "do not duplicate",
        },
      );
      expect(result).toMatchObject({ isError: true });
      expect(result.structuredContent).toEqual({
        error: {
          code: "tool_outcome_unknown",
          message:
            "Tool outcome uncertain: the provider returned 401 after receiving the request. OpenGeni did not replay this call. Do not retry automatically; verify provider state before any new attempt.",
          retryable: false,
          outcomeUnknown: true,
        },
      });
      const text = JSON.stringify(result);
      expect(text).toMatch(/outcome uncertain/i);
      expect(text).toMatch(/did not replay/i);
      expect(text).toMatch(/do not retry automatically/i);
      expect(text).toMatch(/verify provider state/i);
      expect(text).toContain("unauthorized");
      expect(mcp.requests.filter((request) => request.jsonRpcMethod === "tools/call")).toHaveLength(
        1,
      );
      expect(mcp.calls).toHaveLength(0);
      expect(providerAuthorizations - setupAuthorizations).toBe(1);
      expect(
        resolved.some((input) => input.toolName === "search_documents" && input.forceRefresh),
      ).toBe(true);
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
      const result = await prepared.mcpServers[0]!.callToolResult!("cap-scoped__search_documents", {
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

  test("retains successful host provenance for provider insufficient-scope auth", async () => {
    const connectionId = "legacy-host-scoped-binding";
    const mcp = startTestMcpServer({
      forbiddenTools: ["search_documents"],
      forbiddenAuthenticateHeader: 'Bearer error="insufficient_scope", scope="deploy:read"',
    });
    const authNeeded: ToolAuthNeededPayload[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "host-scoped",
            name: "Legacy host scoped binding",
            url: mcp.url,
            connectionRef: {
              connectionId,
              providerDomain: "host.example.test",
              kind: "delegated",
              scopes: ["deploy:read"],
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "host-scoped" }],
      {
        workspaceId: "66666666-6666-4666-8666-666666666666",
        resolveCredential: async (): Promise<ResolveConnectionCredentialResult> => ({
          status: "ok",
          authoritySource: "host",
          connectionId,
          headers: {},
        }),
        onAuthNeeded: (payload) => authNeeded.push(payload),
      },
    );
    try {
      await prepared.mcpServers[0]!.listTools();
      const result = await prepared.mcpServers[0]!.callToolResult!(
        "host-scoped__search_documents",
        { query: "scope" },
      );
      expect(result).toMatchObject({ isError: true });
      expect(authNeeded).toContainEqual(
        expect.objectContaining({
          serverId: "host-scoped",
          toolName: "search_documents",
          providerDomain: "host.example.test",
          connectionId,
          authoritySource: "host",
          reason: "insufficient_scope",
          scopes: ["deploy:read"],
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
      const result = await prepared.mcpServers[0]!.callToolResult!(
        "cap-forbidden__search_documents",
        {
          query: "scope",
        },
      );
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
          return {
            status: "ok",
            connectionId,
            headers: { authorization: "Bearer list-token" },
          };
        },
        onAuthNeeded: (payload) => {
          authNeeded.push(payload);
        },
      },
    );
    try {
      await prepared.mcpServers[0]!.listTools();
      const result = await prepared.mcpServers[0]!.callToolResult!(
        "cap-auth-needed__search_documents",
        {
          query: "auth",
        },
      );
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "Authentication required - a connection link was posted to the session.",
          },
        ],
      });
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

  test("preserves actionable auth for single and batched optional MCP tool calls", async () => {
    const connectionId = "79797979-7979-4979-8979-797979797979";
    const mcp = startTestMcpServer();
    const authNeeded: ToolAuthNeededPayload[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "cap-batched-auth",
            name: "Batched auth capability MCP",
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
      [{ kind: "mcp", id: "cap-batched-auth", optional: true }],
      {
        workspaceId: "89898989-8989-4989-8989-898989898989",
        resolveCredential: async (input): Promise<ResolveConnectionCredentialResult> =>
          input.toolName
            ? {
                status: "auth_needed",
                reason: "expired",
                providerDomain: "api.example.com",
                connectionId,
              }
            : {
                status: "ok",
                connectionId,
                headers: { authorization: "Bearer list-token" },
              },
        onAuthNeeded: (payload) => authNeeded.push(payload),
      },
    );
    try {
      const server = prepared.mcpServers[0]!;
      await server.listTools();
      const brokerFetch = (
        server as unknown as {
          inner: {
            underlying: {
              params: {
                fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
              };
            };
          };
        }
      ).inner.underlying.params.fetch;
      const invoke = async (body: unknown) =>
        await brokerFetch(mcp.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const expectedError = {
        code: 40_101,
        message: "Authentication required - a connection link was posted to the session.",
      };

      const single = await invoke({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: { name: "create_issue", arguments: {} },
      });
      expect(single.status).toBe(200);
      expect(await single.json()).toEqual({
        jsonrpc: "2.0",
        id: 101,
        error: expectedError,
      });
      expect(authNeeded).toHaveLength(1);

      const oneEntryBatch = await invoke([
        {
          jsonrpc: "2.0",
          id: 102,
          method: "tools/call",
          params: { name: "create_issue", arguments: {} },
        },
      ]);
      expect(oneEntryBatch.status).toBe(200);
      expect(await oneEntryBatch.json()).toEqual([
        { jsonrpc: "2.0", id: 102, error: expectedError },
      ]);
      expect(authNeeded).toHaveLength(2);

      const mixedBatch = await invoke([
        { jsonrpc: "2.0", id: 103, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 104,
          method: "tools/call",
          params: { name: "create_issue", arguments: {} },
        },
      ]);
      expect(mixedBatch.status).toBe(200);
      expect(await mixedBatch.json()).toEqual([
        { jsonrpc: "2.0", id: 103, error: expectedError },
        { jsonrpc: "2.0", id: 104, error: expectedError },
      ]);
      expect(authNeeded).toHaveLength(3);
      expect(authNeeded).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({
            serverId: "cap-batched-auth",
            toolName: "create_issue",
            reason: "expired",
          }),
        ),
      );
      expect(mcp.calls).toEqual([]);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("never classifies the MCP SDK request-timeout code as connection auth", async () => {
    let markStarted: (() => void) | null = null;
    let releaseCall: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const mcp = startTestMcpServer({
      beforeToolCall: async () => {
        markStarted?.();
        await gate;
      },
    });
    const authNeeded: unknown[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "request-timeout",
            name: "Request timeout",
            url: mcp.url,
            cacheToolsList: false,
            timeoutMs: 1_000,
          },
        ],
      }),
      [{ kind: "mcp", id: "request-timeout" }],
      {
        onAuthNeeded: (payload) => {
          authNeeded.push(payload);
        },
      },
    );
    try {
      await prepared.mcpServers[0]!.listTools();
      const pending = prepared.mcpServers[0]!.callTool("request-timeout__search_documents", {
        query: "wait",
      });
      await started;
      let failure: unknown;
      try {
        await pending;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ code: ErrorCode.RequestTimeout });
      expect((failure as Error).message).toBe(
        `MCP error ${ErrorCode.RequestTimeout}: Request timed out`,
      );
      expect(authNeeded).toEqual([]);
    } finally {
      releaseCall?.();
      await prepared.close();
      mcp.close();
    }
  }, 10_000);

  test("skips an optional brokered MCP at connect time without emitting setup auth-needed", async () => {
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
        [{ kind: "mcp", id: "cap-missing", optional: true }],
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
        expect(authNeeded).toEqual([]);
      } finally {
        await prepared.close();
      }
    } finally {
      console.warn = originalWarn;
    }
  });

  test("keeps setup auth-needed for a non-optional brokered MCP selection", async () => {
    const authNeeded: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            {
              id: "cap-required-auth",
              name: "Required auth capability MCP",
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
        [{ kind: "mcp", id: "cap-required-auth" }],
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
            serverId: "cap-required-auth",
            toolName: null,
            reason: "missing_connection",
            providerDomain: "api.example.com",
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
    const mcp = startTestMcpServer({
      requiredHeaders: { "x-api-key": "capability-credential" },
    });
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

  test("codex_apps: injects only the explicit Apps bearer + account-id", async () => {
    const mcp = startTestMcpServer({
      requiredHeaders: {
        authorization: "Bearer tok-123",
        "chatgpt-account-id": "acct-9",
      },
    });
    const auth = makeCodexAppsAuth();
    const authorize = auth.withAuthorization;
    let tokenResolutions = 0;
    auth.withAuthorization = async (use) => {
      tokenResolutions += 1;
      return await authorize(use);
    };
    const prepared = await prepareAgentTools(
      testSettings({ mcpServers: [CODEX_APPS_ENTRY()] }),
      [{ kind: "mcp", id: "codex_apps" }],
      { codexAppsAuth: auth, mcpFetchImpl: codexAppsTestFetch(mcp.url) },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(1);
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toContain("codex_apps__search_documents");
      const result = await prepared.mcpServers[0]!.callTool("codex_apps__search_documents", {
        query: "gmail",
      });
      expect(JSON.stringify(result)).toContain("found document for gmail");
      expect(tokenResolutions).toBeGreaterThanOrEqual(2);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("codex_apps: rejects a reserved id pointed at a non-canonical endpoint", async () => {
    await expect(
      prepareAgentTools(
        testSettings({
          mcpServers: [
            {
              id: "codex_apps",
              name: "hostile",
              url: "https://attacker.example/mcp",
              cacheToolsList: false,
            },
          ],
        }),
        [{ kind: "mcp", id: "codex_apps" }],
        { codexAppsAuth: makeCodexAppsAuth() },
      ),
    ).rejects.toThrow("reserved for the canonical endpoint");
  });

  test("codex_apps: emits X-OpenAI-Product-Sku only when configured", async () => {
    const withSku = startTestMcpServer({
      requiredHeaders: {
        authorization: "Bearer tok-123",
        "X-OpenAI-Product-Sku": "plus",
      },
    });
    const preparedWith = await prepareAgentTools(
      testSettings({
        codexProductSku: "plus",
        mcpServers: [CODEX_APPS_ENTRY()],
      }),
      [{ kind: "mcp", id: "codex_apps" }],
      {
        codexAppsAuth: makeCodexAppsAuth(),
        mcpFetchImpl: codexAppsTestFetch(withSku.url),
      },
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
      requiredHeaders: {
        authorization: "Bearer tok-123",
        "X-OpenAI-Product-Sku": "plus",
      },
    });
    const preparedWithout = await prepareAgentTools(
      testSettings({ mcpServers: [CODEX_APPS_ENTRY()] }),
      [{ kind: "mcp", id: "codex_apps" }],
      {
        codexAppsAuth: makeCodexAppsAuth(),
        mcpFetchImpl: codexAppsTestFetch(requiresSku.url),
      },
    );
    try {
      expect(preparedWithout.mcpServers).toHaveLength(0); // header absent => connect rejected => dropped
    } finally {
      await preparedWithout.close();
      requiresSku.close();
    }
  });

  test("codex_apps: authorization revoked after discovery blocks the remote tool call", async () => {
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer tok-123" },
    });
    let authorized = true;
    const auth = makeCodexAppsAuth();
    const authorize = auth.withAuthorization;
    auth.withAuthorization = async (use) => {
      if (!authorized) throw new Error("Codex Apps authorization was revoked");
      return await authorize(use);
    };
    const prepared = await prepareAgentTools(
      testSettings({ mcpServers: [CODEX_APPS_ENTRY()] }),
      [{ kind: "mcp", id: "codex_apps" }],
      { codexAppsAuth: auth, mcpFetchImpl: codexAppsTestFetch(mcp.url) },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(1);
      await prepared.mcpServers[0]!.listTools();
      authorized = false;
      const result = await prepared.mcpServers[0]!.callToolResult!("codex_apps__search_documents", {
        query: "must-not-run",
      });
      expect(result).toMatchObject({ isError: true });
      expect(mcp.calls).toEqual([]);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("codex_apps: no explicit Apps auth => graceful best-effort drop", async () => {
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer tok-123" },
    });
    const authNeeded: ToolAuthNeededPayload[] = [];
    // Inference authentication is deliberately not consulted as a fallback.
    const prepared = await prepareAgentTools(
      testSettings({ mcpServers: [CODEX_APPS_ENTRY()] }),
      [{ kind: "mcp", id: "codex_apps" }],
      {
        mcpFetchImpl: codexAppsTestFetch(mcp.url),
        onAuthNeeded: (payload) => authNeeded.push(payload),
      },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(0);
      expect(mcp.calls).toEqual([]);
      expect(authNeeded).toContainEqual(
        expect.objectContaining({
          serverId: "codex_apps",
          providerDomain: "chatgpt.com",
          reason: "missing_connection",
          toolName: null,
        }),
      );
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("codex_apps: provider 401 publishes an actionable expired-auth signal", async () => {
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer provider-rejected" },
    });
    const authNeeded: ToolAuthNeededPayload[] = [];
    const prepared = await prepareAgentTools(
      testSettings({ mcpServers: [CODEX_APPS_ENTRY()] }),
      [{ kind: "mcp", id: "codex_apps" }],
      {
        codexAppsAuth: makeCodexAppsAuth(),
        mcpFetchImpl: codexAppsTestFetch(mcp.url),
        onAuthNeeded: (payload) => authNeeded.push(payload),
      },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(0);
      expect(authNeeded).toContainEqual(
        expect.objectContaining({
          serverId: "codex_apps",
          providerDomain: "chatgpt.com",
          reason: "expired",
          toolName: null,
        }),
      );
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("codex_apps: transport setup failure is retryable without a false refresh-auth signal", async () => {
    const authNeeded: ToolAuthNeededPayload[] = [];
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const prepared = await prepareAgentTools(
        testSettings({ mcpServers: [CODEX_APPS_ENTRY()] }),
        [{ kind: "mcp", id: "codex_apps" }],
        {
          codexAppsAuth: makeCodexAppsAuth(),
          mcpFetchImpl: async () => {
            throw Object.assign(new Error("socket closed with credential-shaped body"), {
              code: "ECONNRESET",
            });
          },
          onAuthNeeded: (payload) => authNeeded.push(payload),
        },
      );
      try {
        expect(prepared.mcpServers).toHaveLength(0);
      } finally {
        await prepared.close();
      }
      expect(authNeeded).toEqual([]);
      const renderedWarnings = JSON.stringify(warnings);
      expect(renderedWarnings).toContain('"serverId":"codex_apps"');
      expect(renderedWarnings).toContain('"retryable":true');
      expect(renderedWarnings).not.toContain("socket closed with credential-shaped body");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("codex_apps ignores configured static credentials instead of using a fallback", async () => {
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer static-must-not-be-used" },
    });
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            ...CODEX_APPS_ENTRY(),
            headers: { authorization: "Bearer static-must-not-be-used" },
          },
        ],
      }),
      [{ kind: "mcp", id: "codex_apps" }],
      { mcpFetchImpl: codexAppsTestFetch(mcp.url) },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(0);
      expect(mcp.calls).toEqual([]);
    } finally {
      await prepared.close();
      mcp.close();
    }
  });

  test("codex_apps: getToken rejection (needs_relogin) => graceful best-effort drop", async () => {
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer tok-123" },
    });
    const authNeeded: ToolAuthNeededPayload[] = [];
    const prepared = await prepareAgentTools(
      testSettings({ mcpServers: [CODEX_APPS_ENTRY()] }),
      [{ kind: "mcp", id: "codex_apps" }],
      {
        codexAppsAuth: makeCodexAppsAuth({
          tokenError: new Error("needs_relogin"),
        }),
        mcpFetchImpl: codexAppsTestFetch(mcp.url),
        onAuthNeeded: (payload) => authNeeded.push(payload),
      },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(0);
      expect(mcp.calls).toEqual([]);
      expect(authNeeded).toContainEqual(
        expect.objectContaining({
          serverId: "codex_apps",
          providerDomain: "chatgpt.com",
          reason: "refresh_failed",
          toolName: null,
        }),
      );
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
    const apps = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer tok-123" },
    });
    try {
      await expect(
        prepareAgentTools(
          testSettings({
            mcpServers: [
              {
                id: "cap-secure",
                name: "Secure capability MCP",
                url: required.url,
                cacheToolsList: false,
              }, // no headers => fails strict
              CODEX_APPS_ENTRY(),
            ],
          }),
          [
            { kind: "mcp", id: "cap-secure" },
            { kind: "mcp", id: "codex_apps" },
          ],
          {
            codexAppsAuth: makeCodexAppsAuth(),
            mcpFetchImpl: codexAppsTestFetch(apps.url),
          },
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
      expect(warnings.length).toBeGreaterThan(0);
      expect(JSON.stringify(warnings)).toContain('"serverId":"geni-notebook"');
      expect(JSON.stringify(warnings)).toContain('"origin":"runtime"');
    } finally {
      console.warn = originalWarn;
      broken.close();
    }
  });

  test("a rejected optional connection group fails open without weakening required MCP", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const settlement = source.slice(
      source.indexOf("const connectEntryGroups = async"),
      source.indexOf("const connectedEager = await connectEntryGroups"),
    );
    expect(settlement).toContain('if (requiredResult.status === "rejected")');
    expect(settlement).toContain("throw requiredResult.reason");
    expect(settlement).toContain('if (bestEffortResult.status === "rejected")');
    expect(settlement).toContain("entry.server.releaseAggregateBudget()");
    expect(settlement.match(/throw /g)).toHaveLength(1);
  });

  test("waits only for required session-eager MCP preparation and defers optional eager servers", async () => {
    let releaseOptional!: () => void;
    const optionalConnect = new Promise<void>((resolve) => {
      releaseOptional = resolve;
    });
    const makeServer = (name: string, connect: () => Promise<void>): MCPServer => ({
      name,
      cacheToolsList: false,
      connect,
      async close() {},
      async listTools() {
        return [
          {
            name: "lookup",
            description: `Lookup through ${name}`,
            inputSchema: {
              type: "object" as const,
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return [{ type: "text", text: name }];
      },
      async invalidateToolsCache() {},
    });
    const eager = makeServer("eager-inner", async () => {});
    const strict = makeServer("strict-inner", async () => await optionalConnect);
    const optional = makeServer("optional-inner", async () => await optionalConnect);
    const configs = [
      {
        id: "eager",
        name: "Eager",
        url: "https://eager.invalid/mcp",
        cacheToolsList: false,
      },
      {
        id: "strict",
        name: "Strict",
        url: "https://strict.invalid/mcp",
        cacheToolsList: false,
      },
      {
        id: "optional",
        name: "Optional",
        url: "https://optional.invalid/mcp",
        cacheToolsList: false,
      },
    ];
    const settings = testSettings({ sandboxBackend: "none", mcpServers: configs });
    const prepared = await prepareAgentTools(
      settings,
      [
        { kind: "mcp", id: "eager", eager: true },
        { kind: "mcp", id: "strict" },
        { kind: "mcp", id: "optional", optional: true, eager: true },
      ],
      {
        deferNonEagerUntilToolDemand: true,
        localMcpServers: [
          { id: "eager", server: eager },
          { id: "strict", server: strict },
          { id: "optional", server: optional },
        ],
      },
    );
    try {
      expect(prepared.ready).toBeDefined();
      const agent = buildOpenGeniAgent(settings, [], {
        mcpServers: prepared.mcpServers,
      });
      expect((await agent.getMcpTools(new RunContext())).map((tool) => tool.name)).toEqual([
        "eager__lookup",
      ]);

      releaseOptional();
      const complete = await prepared.ready!;
      expect((await agent.getMcpTools(new RunContext())).map((tool) => tool.name).sort()).toEqual([
        "eager__lookup",
        "optional__lookup",
        "strict__lookup",
      ]);
      expect(complete.attemptToolEnvironment).toBeNull();
    } finally {
      releaseOptional();
      await prepared.close();
    }
  });

  test("binds published local model tools only to the final combined attempt environment", async () => {
    let releaseDeferred!: () => void;
    const deferredConnect = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });
    const deferred: MCPServer = {
      name: "deferred-inner",
      cacheToolsList: false,
      async connect() {
        await deferredConnect;
      },
      async close() {},
      async listTools() {
        return [
          {
            name: "lookup",
            description: "Deferred lookup",
            inputSchema: { type: "object" as const, additionalProperties: false },
          },
        ];
      },
      async callTool() {
        return [{ type: "text", text: "deferred" }];
      },
      async callToolResult() {
        return { content: [{ type: "text", text: "deferred" }] };
      },
      async invalidateToolsCache() {},
    };
    let localExecutions = 0;
    const settings = testSettings({
      sandboxBackend: "none",
      mcpServers: [
        {
          id: "docs",
          name: "Docs",
          url: "https://docs.invalid/mcp",
          cacheToolsList: false,
        },
      ],
    });
    const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "docs" }], {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 3,
      deferNonEagerUntilToolDemand: true,
      localMcpServers: [{ id: "docs", server: deferred }],
      attemptToolDefinitions: [
        {
          identity: { serverId: "interaction", toolName: "observe" },
          modelName: "interaction__observe",
          codemodePath: ["interaction", "observe"],
          inputSchema: { type: "object", additionalProperties: false },
          source: "interaction",
          approval: "none",
          execute: async () => {
            localExecutions += 1;
            return { content: [{ type: "text", text: "observed" }] };
          },
        },
      ],
    });
    try {
      const local = prepared.mcpServers.find(
        (server) => server.name === "opengeni-attempt-local-tools",
      );
      expect(local).toBeDefined();
      const modelCall = local!.callToolResult!("interaction__observe", {});
      let modelCallSettled = false;
      void modelCall.finally(() => {
        modelCallSettled = true;
      });
      await Bun.sleep(10);
      expect(modelCallSettled).toBe(false);
      expect(localExecutions).toBe(0);

      releaseDeferred();
      expect(await modelCall).toMatchObject({
        content: [{ type: "text", text: "observed" }],
      });
      const complete = await prepared.ready!;
      expect(
        complete.attemptToolEnvironment!.catalog.entries.map((entry) => entry.identity),
      ).toEqual(
        expect.arrayContaining([
          { serverId: "docs", toolName: "lookup" },
          { serverId: "interaction", toolName: "observe" },
        ]),
      );
      expect(
        await complete.attemptToolEnvironment!.call({
          operationId: "66666666-6666-4666-8666-666666666666",
          catalogDigest: complete.attemptToolEnvironment!.catalog.digest,
          identity: { serverId: "interaction", toolName: "observe" },
          arguments: {},
          caller: { kind: "codemode", subjectId: "agent:test" },
        }),
      ).toMatchObject({ content: [{ type: "text", text: "observed" }] });
      expect(localExecutions).toBe(2);
    } finally {
      releaseDeferred();
      await prepared.close();
    }
  });

  test("keeps published local and eager servers live when deferred preparation fails", async () => {
    const deferredFailure = new Error("synthetic deferred MCP preparation failure");
    let rejectDeferred!: (error: Error) => void;
    const deferredConnect = new Promise<void>((_resolve, reject) => {
      rejectDeferred = reject;
    });
    let eagerCloseCount = 0;
    let deferredCloseCount = 0;
    const makeServer = (
      name: string,
      connect: () => Promise<void>,
      onClose: () => void,
    ): MCPServer => ({
      name,
      cacheToolsList: false,
      connect,
      async close() {
        onClose();
      },
      async listTools() {
        return [
          {
            name: "lookup",
            description: `Lookup through ${name}`,
            inputSchema: {
              type: "object" as const,
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return [{ type: "text", text: name }];
      },
      async invalidateToolsCache() {},
    });
    const eager = makeServer(
      "eager-inner",
      async () => {},
      () => {
        eagerCloseCount += 1;
      },
    );
    const deferred = makeServer(
      "deferred-inner",
      async () => await deferredConnect,
      () => {
        deferredCloseCount += 1;
      },
    );
    const settings = testSettings({
      sandboxBackend: "none",
      mcpServers: [
        {
          id: "eager",
          name: "Eager",
          url: "https://eager.invalid/mcp",
          cacheToolsList: false,
        },
        {
          id: "deferred",
          name: "Deferred",
          url: "https://deferred.invalid/mcp",
          cacheToolsList: false,
        },
      ],
    });
    const prepared = await prepareAgentTools(
      settings,
      [
        { kind: "mcp", id: "eager", eager: true },
        { kind: "mcp", id: "deferred" },
      ],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 2,
        deferNonEagerUntilToolDemand: true,
        localMcpServers: [
          { id: "eager", server: eager },
          { id: "deferred", server: deferred },
        ],
        attemptToolDefinitions: [
          {
            identity: { serverId: "interaction", toolName: "browser_observe" },
            modelName: "interaction__browser_observe",
            codemodePath: ["interaction", "browser", "observe"],
            description: "Observe one exact browser target.",
            inputSchema: {
              type: "object",
              properties: { targetId: { type: "string" } },
              required: ["targetId"],
              additionalProperties: false,
            },
            source: "interaction",
            approval: "none",
            execute: async () => ({ content: [{ type: "text", text: "observed" }] }),
          },
        ],
      },
    );
    const local = prepared.mcpServers.find(
      (server) => server.name === "opengeni-attempt-local-tools",
    );
    const publishedEager = prepared.mcpServers.find((server) => server.name.includes("eager"));
    expect(local).toBeDefined();
    expect(publishedEager).toBeDefined();
    expect((await local!.listTools()).map((tool) => tool.name)).toEqual([
      "interaction__browser_observe",
    ]);

    rejectDeferred(deferredFailure);
    await expect(prepared.ready!).rejects.toBe(deferredFailure);

    expect(eagerCloseCount).toBe(0);
    expect(deferredCloseCount).toBe(1);
    expect((await local!.listTools()).map((tool) => tool.name)).toEqual([
      "interaction__browser_observe",
    ]);
    expect((await publishedEager!.listTools()).map((tool) => tool.name)).toEqual(["eager__lookup"]);

    await expect(prepared.close()).rejects.toBe(deferredFailure);
    expect(eagerCloseCount).toBe(1);
    expect(deferredCloseCount).toBe(1);
    await expect(local!.listTools()).rejects.toThrow("local model tool server is closed");
  });

  test("closes unpublished eager and deferred servers when eager schema freezing fails", async () => {
    const eagerFailure = new Error("synthetic eager schema failure");
    let eagerCloseCount = 0;
    let deferredCloseCount = 0;
    const settings = testSettings({
      sandboxBackend: "none",
      mcpServers: [
        { id: "eager", name: "Eager", url: "https://eager.invalid/mcp" },
        { id: "deferred", name: "Deferred", url: "https://deferred.invalid/mcp" },
      ],
    });
    const server = (
      name: string,
      listTools: () => Promise<RuntimeMcpTool[]>,
      onClose: () => void,
    ): MCPServer => ({
      name,
      cacheToolsList: false,
      async connect() {},
      async close() {
        onClose();
      },
      listTools,
      async callTool() {
        return [];
      },
      async invalidateToolsCache() {},
    });

    await expect(
      prepareAgentTools(
        settings,
        [
          { kind: "mcp", id: "eager", eager: true },
          { kind: "mcp", id: "deferred" },
        ],
        {
          deferNonEagerUntilToolDemand: true,
          localMcpServers: [
            {
              id: "eager",
              server: server(
                "eager-inner",
                async () => {
                  throw eagerFailure;
                },
                () => {
                  eagerCloseCount += 1;
                },
              ),
            },
            {
              id: "deferred",
              server: server(
                "deferred-inner",
                async () => [],
                () => {
                  deferredCloseCount += 1;
                },
              ),
            },
          ],
        },
      ),
    ).rejects.toBe(eagerFailure);
    expect(eagerCloseCount).toBe(1);
    expect(deferredCloseCount).toBe(1);
  });

  test("does not close eager servers twice when fully prepared cleanup fails", async () => {
    const closeFailure = new Error("synthetic eager close failure");
    let eagerCloseCount = 0;
    let deferredCloseCount = 0;
    const makeServer = (name: string, eager: boolean): MCPServer => ({
      name,
      cacheToolsList: false,
      async connect() {},
      async close() {
        if (eager) {
          eagerCloseCount += 1;
          throw closeFailure;
        }
        deferredCloseCount += 1;
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return [];
      },
      async invalidateToolsCache() {},
    });
    const settings = testSettings({
      sandboxBackend: "none",
      mcpServers: [
        { id: "eager", name: "Eager", url: "https://eager.invalid/mcp" },
        { id: "deferred", name: "Deferred", url: "https://deferred.invalid/mcp" },
      ],
    });
    const prepared = await prepareAgentTools(
      settings,
      [
        { kind: "mcp", id: "eager", eager: true },
        { kind: "mcp", id: "deferred" },
      ],
      {
        deferNonEagerUntilToolDemand: true,
        localMcpServers: [
          { id: "eager", server: makeServer("eager-inner", true) },
          { id: "deferred", server: makeServer("deferred-inner", false) },
        ],
      },
    );
    await prepared.ready;
    await expect(prepared.close()).rejects.toBe(closeFailure);
    expect(eagerCloseCount).toBe(1);
    expect(deferredCloseCount).toBe(1);
  });

  test("SDK MCP lifecycle logs are structural while callers receive exact errors", async () => {
    const sentinel = "synthetic-mcp-lifecycle-boundary-123456";
    const registryId = "registry-mcp-lifecycle-boundary";
    const exactSourceError = Object.assign(new Error(`connect failed: ${sentinel}`), {
      name: sentinel,
      code: sentinel,
      status: 503,
      responseBody: { sentinel },
      cause: { exact: sentinel },
    });
    const guarded = guardedMcpFetch(
      testSettings(),
      async () => {
        throw exactSourceError;
      },
      {
        dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
        pinResolvedDestination: false,
      },
    );
    await expect(
      guarded("https://example.test/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    ).rejects.toBe(exactSourceError);
    const transportDiagnostic = mcpTransportRequestFailureDiagnostic(exactSourceError);
    expect(transportDiagnostic).toMatchObject({
      httpMethod: "POST",
      rpcMethod: "initialize",
      causeChainComplete: true,
    });
    const lifecycleObservations: Array<
      Parameters<NonNullable<RuntimeMetricsHooks["onMcpLifecycle"]>>[0]
    > = [];
    configureRuntimeMetricsHooks({
      onMcpLifecycle: (input) => lifecycleObservations.push(input),
    });
    const makeFacade = (bestEffort = false) =>
      new PrefixedMcpServer(
        {
          name: `inner-${registryId}`,
          cacheToolsList: false,
          async connect() {
            throw exactSourceError;
          },
          async close() {},
          async listTools() {
            return [];
          },
          async callTool() {
            return [];
          },
          async invalidateToolsCache() {},
        } as MCPServer,
        registryId,
        undefined,
        bestEffort,
      );
    const warnings: unknown[][] = [];
    const errors: unknown[][] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => warnings.push(args);
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const bestEffortFacade = makeFacade(true);
      const bestEffort = await connectMcpServersInBatches([bestEffortFacade], {
        strict: false,
      });
      const returnedError = bestEffort.errors.get(bestEffortFacade);
      expect(returnedError).toBe(exactSourceError);
      expect(mcpTransportRequestFailureDiagnostic(returnedError)).toEqual(transportDiagnostic);
      await bestEffort.close();

      const strictFacade = makeFacade();
      const strictError = await connectMcpServersInBatches([strictFacade], {
        strict: true,
      }).then(
        () => null,
        (error) => error as Error,
      );
      expect(strictError).toBe(exactSourceError);
      expect(mcpTransportRequestFailureDiagnostic(strictError)).toEqual(transportDiagnostic);

      const renderedLogs = [...warnings, ...errors]
        .flat()
        .map((value) => (value instanceof Error ? `${value.name}: ${value.message}` : value))
        .map((value) => JSON.stringify(value))
        .join("\n");
      const lifecycleErrors = [...warnings, ...errors]
        .flat()
        .filter((value): value is Error => value instanceof Error);
      expect(renderedLogs).toContain("McpLifecycleError");
      expect(renderedLogs).toContain(registryId);
      expect(lifecycleErrors).toContainEqual(
        expect.objectContaining({
          name: "McpLifecycleError",
          code: "mcp_connect_failed",
          serverId: registryId,
          status: 503,
          retryable: true,
          origin: "runtime",
        }),
      );
      expect(renderedLogs).not.toContain(sentinel);
      expect(exactSourceError.message).toContain(sentinel);
      expect(exactSourceError.responseBody).toEqual({ sentinel });
      expect(exactSourceError.cause).toEqual({ exact: sentinel });
      expect(
        lifecycleObservations.map(({ phase, policy, outcome }) => ({ phase, policy, outcome })),
      ).toEqual([
        { phase: "connect", policy: "best_effort", outcome: "failed" },
        { phase: "close", policy: "best_effort", outcome: "completed" },
        { phase: "connect", policy: "strict", outcome: "failed" },
        { phase: "close", policy: "strict", outcome: "completed" },
      ]);
    } finally {
      configureRuntimeMetricsHooks(null);
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  test("SDK MCP lifecycle status projection tolerates hostile proxies without replacing exact errors", async () => {
    const sentinel = "synthetic-mcp-hostile-status-proxy-123456";
    const source = new Error(`connect failed: ${sentinel}`);
    const exactSourceError = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "status" || property === "statusCode") {
          throw new Error(`hostile public status getter: ${sentinel}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const facade = new PrefixedMcpServer(
      {
        name: `inner-${sentinel}`,
        cacheToolsList: false,
        async connect() {
          throw exactSourceError;
        },
        async close() {},
        async listTools() {
          return [];
        },
        async callTool() {
          return [];
        },
        async invalidateToolsCache() {},
      } as MCPServer,
      "registry-hostile-status-proxy",
    );
    const warnings: unknown[][] = [];
    const errors: unknown[][] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => warnings.push(args);
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const result = await connectMcpServersInBatches([facade], {
        strict: false,
      });
      expect(result.errors.get(facade)).toBe(exactSourceError);
      await result.close();
      const lifecycleErrors = [...warnings, ...errors]
        .flat()
        .filter((value): value is Error => value instanceof Error);
      const renderedLogs = [...warnings, ...errors]
        .flat()
        .map((value) => (value instanceof Error ? `${value.name}: ${value.message}` : value))
        .map((value) => JSON.stringify(value))
        .join("\n");
      expect(renderedLogs).toContain("McpLifecycleError");
      expect(renderedLogs).toContain("registry-hostile-status-proxy");
      expect(renderedLogs).not.toContain(sentinel);
      expect(lifecycleErrors).toContainEqual(
        expect.objectContaining({
          name: "McpLifecycleError",
          code: "mcp_connect_failed",
          origin: "runtime",
        }),
      );
      expect(lifecycleErrors.some((error) => "status" in error)).toBe(false);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  test("MCP cleanup closes every batch and returns the first exact close error", async () => {
    const sentinel = "synthetic-mcp-close-boundary-4d7e91";
    const closeCalls: number[] = [];
    const exactCloseErrors = new Map<number, Error>();
    const servers = Array.from({ length: MCP_MAX_CONCURRENT_SERVER_OPERATIONS + 1 }, (_, index) => {
      const exactCloseError = Object.assign(new Error(`close failed ${index}: ${sentinel}`), {
        name: `${sentinel}-${index}`,
        code: `${sentinel}-code-${index}`,
        status: 502,
        cause: { exact: `${sentinel}-cause-${index}` },
      });
      if (index === 0 || index === MCP_MAX_CONCURRENT_SERVER_OPERATIONS) {
        exactCloseErrors.set(index, exactCloseError);
      }
      return new PrefixedMcpServer(
        {
          name: `inner-${sentinel}-${index}`,
          cacheToolsList: false,
          async connect() {},
          async close() {
            closeCalls.push(index);
            const failure = exactCloseErrors.get(index);
            if (failure) throw failure;
          },
          async listTools() {
            return [];
          },
          async callTool() {
            return [];
          },
          async invalidateToolsCache() {},
        } as MCPServer,
        `registry-close-boundary-${index}`,
      );
    });
    const warnings: unknown[][] = [];
    const errors: unknown[][] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => warnings.push(args);
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const connected = await connectMcpServersInBatches(servers, {
        strict: true,
      });
      const closeError = await connected.close().then(
        () => null,
        (error) => error as Error,
      );
      expect(closeCalls.toSorted((left, right) => left - right)).toEqual(
        servers.map((_, index) => index),
      );
      expect(closeError).toBe(exactCloseErrors.get(MCP_MAX_CONCURRENT_SERVER_OPERATIONS));
      expect(closeError?.cause).toEqual({
        exact: `${sentinel}-cause-${MCP_MAX_CONCURRENT_SERVER_OPERATIONS}`,
      });
      const renderedLogs = JSON.stringify([...warnings, ...errors]);
      expect(renderedLogs).toContain("McpLifecycleError");
      expect(renderedLogs).toContain("mcp_close_failed");
      expect(renderedLogs).not.toContain(sentinel);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
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
            {
              id: "geni-notebook",
              name: "Geni Notebook",
              url: broken.url,
              cacheToolsList: false,
            },
            {
              id: "docs",
              name: "Document Search",
              url: healthy.url,
              cacheToolsList: false,
            },
          ],
        }),
        [
          { kind: "mcp", id: "geni-notebook", optional: true },
          { kind: "mcp", id: "docs" },
        ],
      );
      try {
        expect(prepared.mcpServers.map(runtimeMcpServerId)).toEqual(["docs"]);
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

  test("parallel best-effort setup preserves active/failed registry identities", async () => {
    const exactSlackError = Object.assign(new Error("provider socket failed"), {
      code: "ECONNRESET",
    });
    const apps = new PrefixedMcpServer(
      {
        name: "inner-codex-apps",
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
      } as MCPServer,
      "codex_apps",
      undefined,
      true,
    );
    const slack = new PrefixedMcpServer(
      {
        name: "inner-slack",
        cacheToolsList: false,
        async connect() {
          throw exactSlackError;
        },
        async close() {},
        async listTools() {
          return [];
        },
        async callTool() {
          return [];
        },
        async invalidateToolsCache() {},
      } as MCPServer,
      "slack",
      undefined,
      true,
      undefined,
      "slack",
      true,
    );
    const warnings: unknown[][] = [];
    const errors: unknown[][] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => warnings.push(args);
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const connected = await connectMcpServersInBatches([apps, slack], {
        strict: false,
      });
      try {
        expect(connected.active.map(runtimeMcpServerId)).toEqual(["codex_apps"]);
        expect(connected.failed.map(runtimeMcpServerId)).toEqual(["slack"]);
        expect(connected.errors.get(slack)).toBe(exactSlackError);
        expect(apps.name).not.toBe(slack.name);
        expect(apps.name).toContain("codex_apps");
        expect(slack.name).toContain("slack");
        const renderedLogs = JSON.stringify([...warnings, ...errors]);
        expect(renderedLogs).toContain('"serverId":"slack"');
        expect(renderedLogs).toContain('"retryable":true');
        expect(renderedLogs).not.toContain("provider socket failed");
      } finally {
        await connected.close();
      }
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  test("codex_apps survives a parallel best-effort sibling connect failure", async () => {
    const broken = startTestMcpServer({
      requiredHeaders: { "x-api-key": "capability-credential" },
    });
    const apps = startTestMcpServer({
      requiredHeaders: {
        authorization: "Bearer tok-123",
        "chatgpt-account-id": "acct-9",
      },
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            CODEX_APPS_ENTRY(),
            {
              id: "slack",
              name: "Slack",
              url: broken.url,
              cacheToolsList: false,
            },
          ],
        }),
        [
          { kind: "mcp", id: "codex_apps", optional: true },
          { kind: "mcp", id: "slack", optional: true },
        ],
        {
          codexAppsAuth: makeCodexAppsAuth(),
          mcpFetchImpl: codexAppsTestFetch(apps.url),
        },
      );
      try {
        expect(prepared.mcpServers.map(runtimeMcpServerId)).toEqual(["codex_apps"]);
        const tools = await prepared.mcpServers[0]!.listTools();
        expect(tools.map((tool) => tool.name)).toContain("codex_apps__search_documents");
      } finally {
        await prepared.close();
      }
    } finally {
      console.warn = originalWarn;
      broken.close();
      apps.close();
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

  test("required first-party setup 404 is recoverable while an external 404 remains terminal", async () => {
    const unavailable = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("temporary route not found", { status: 404 }),
    });
    const url = `http://127.0.0.1:${unavailable.port}/mcp`;
    const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    try {
      let firstPartyFailure: unknown;
      try {
        await prepareAgentTools(
          testSettings({
            opengeniMcpInternalUrl: url,
            mcpServers: [
              {
                id: "opengeni",
                name: "OpenGeni",
                url,
                cacheToolsList: false,
              },
            ],
          }),
          [{ kind: "mcp", id: "opengeni" }],
          { workspaceId },
        );
      } catch (error) {
        firstPartyFailure = error;
      }
      expect(firstPartyFailure).toBeInstanceOf(Error);
      expect(isMcpTransportConnectivityError(firstPartyFailure)).toBe(true);

      let externalFailure: unknown;
      try {
        await prepareAgentTools(
          testSettings({
            mcpServers: [
              {
                id: "external-required",
                name: "External required MCP",
                url,
                cacheToolsList: false,
              },
            ],
          }),
          [{ kind: "mcp", id: "external-required" }],
        );
      } catch (error) {
        externalFailure = error;
      }
      expect(externalFailure).toBeInstanceOf(Error);
      expect(isMcpTransportConnectivityError(externalFailure)).toBe(false);
    } finally {
      unavailable.stop(true);
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
    // invariant: that optional server drops to zero tools without manufacturing
    // a conversational auth card while a healthy sibling's tools survive and the
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
            {
              id: "docs",
              name: "Document Search",
              url: healthy.url,
              cacheToolsList: false,
            },
          ],
        }),
        [
          { kind: "mcp", id: "cap-expired", optional: true },
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
        expect(prepared.mcpServers.map(runtimeMcpServerId).sort()).toEqual(["cap-expired", "docs"]);
        // Drive the exact code path the agent runner uses. Pre-fix this REJECTS
        // (the expired server's tools/list 401 throws out of getAllMcpTools).
        const tools = await getAllMcpTools({ mcpServers: prepared.mcpServers });
        const toolNames = tools.map((tool) => tool.name);
        // The healthy sibling's tools survive; the expired server contributes none.
        expect(toolNames).toContain("docs__search_documents");
        expect(toolNames.some((name) => name.startsWith("cap-expired__"))).toBe(false);
        expect(authNeeded).toEqual([]);
      } finally {
        await prepared.close();
      }
      // The drop is observable as an allowlisted structural warning with the
      // safe registry identity needed to make recovery actionable.
      const warned = warnings.some((args) =>
        args.some(
          (arg) =>
            typeof arg === "object" &&
            arg !== null &&
            typeof (arg as { errorClass?: unknown }).errorClass === "string" &&
            (arg as { origin?: unknown }).origin === "runtime",
        ),
      );
      expect(warned).toBe(true);
      expect(JSON.stringify(warnings)).toContain('"serverId":"cap-expired"');
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
    const brokenOptional = startTestMcpServer({
      serverErrorForMethods: ["tools/list"],
    });
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
            {
              id: "docs",
              name: "Document Search",
              url: healthy.url,
              cacheToolsList: false,
            },
          ],
        }),
        [
          { kind: "mcp", id: "flaky", optional: true },
          { kind: "mcp", id: "docs" },
        ],
      );
      try {
        // The optional server connects (initialize is fine); only tools/list 500s.
        expect(prepared.mcpServers.map(runtimeMcpServerId).sort()).toEqual(["docs", "flaky"]);
        const tools = await getAllMcpTools({ mcpServers: prepared.mcpServers });
        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).toContain("docs__search_documents");
        expect(toolNames.some((name) => name.startsWith("flaky__"))).toBe(false);
      } finally {
        await prepared.close();
      }
      // The non-auth degrade is observable with safe registry identity and
      // without leaking the provider's raw response through the public boundary.
      const warned = warnings.some((args) =>
        args.some(
          (arg) =>
            typeof arg === "object" &&
            arg !== null &&
            typeof (arg as { errorClass?: unknown }).errorClass === "string" &&
            (arg as { origin?: unknown }).origin === "runtime",
        ),
      );
      expect(warned).toBe(true);
      expect(JSON.stringify(warnings)).toContain('"serverId":"flaky"');
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
    const strict = startTestMcpServer({
      unauthorizedForMethods: ["tools/list"],
    });
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            {
              id: "docs-strict",
              name: "Document Search",
              url: strict.url,
              cacheToolsList: false,
            },
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
        { kind: "mcp", id: "cap", optional: true },
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
                authoritySource: "host",
                connectionId,
                authorizationUrl: "https://api.integrations-example.com/oauth/start",
              }
            : {
                status: "ok",
                connectionId,
                headers: { authorization: "Bearer list-token" },
              },
        onAuthNeeded: (payload) => {
          authNeeded.push(payload);
        },
      },
    );
    try {
      const cap = prepared.mcpServers.find((server) => runtimeMcpServerId(server) === "cap")!;
      const docs = prepared.mcpServers.find((server) => runtimeMcpServerId(server) === "docs")!;
      await cap.listTools();
      const result = await cap.callToolResult!("cap__search_documents", {
        query: "x",
      });
      expect(result).toMatchObject({ isError: true });
      expect(authNeeded).toContainEqual(
        expect.objectContaining({
          serverId: "cap",
          toolName: "search_documents",
          reason: "expired",
          authoritySource: "host",
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
    // sees — with LOOP-SAFE copy (do-not-retry) and only the fixed public
    // classification, never the raw response body or arbitrary Error fields —
    // rather than throw.
    const flaky = startTestMcpServer({
      unauthorizedForMethods: ["tools/call"],
    });
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
              name: "Flaky",
              url: flaky.url,
              cacheToolsList: false,
            },
            {
              id: "docs",
              name: "Docs",
              url: healthy.url,
              cacheToolsList: false,
            },
          ],
        }),
        [
          { kind: "mcp", id: "flaky", optional: true },
          { kind: "mcp", id: "docs" },
        ],
      );
      try {
        const flakySrv = prepared.mcpServers.find(
          (server) => runtimeMcpServerId(server) === "flaky",
        )!;
        const docs = prepared.mcpServers.find((server) => runtimeMcpServerId(server) === "docs")!;
        await flakySrv.listTools(); // fine — only tools/call 401s
        const result = await flakySrv.callToolResult!("flaky__search_documents", {
          query: "x",
        });
        expect(result).toMatchObject({ isError: true });
        const text = JSON.stringify(result);
        // Loop-safety: the copy must steer the model away from re-calling it.
        expect(text).toMatch(/do not retry/i);
        // Exact provider text remains visible; no-retry guidance is additive.
        expect(text).toContain("Streamable HTTP error");
        expect(text).toContain("unauthorized");
        // Sibling unaffected.
        const ok = await docs.callTool("docs__search_documents", {
          query: "y",
        });
        expect(JSON.stringify(ok)).toContain("found document for y");
      } finally {
        await prepared.close();
      }
      // The model-visible result above preserves the exact provider message;
      // the public warning is an allowlisted structural projection only.
      const warned = warnings.find((args) =>
        args.some(
          (a) =>
            typeof a === "object" &&
            a !== null &&
            (a as { errorClass?: unknown }).errorClass === "McpOperationError" &&
            (a as { errorCode?: unknown }).errorCode === "mcp_tool_call_failed",
        ),
      );
      expect(warned).toBeDefined();
      const payload = warned!.find((a) => typeof a === "object" && a !== null) as Record<
        string,
        unknown
      >;
      expect(payload).toMatchObject({
        errorClass: "McpOperationError",
        errorCode: "mcp_tool_call_failed",
        origin: "runtime",
      });
      expect(payload.status).toBeUndefined();
      expect(JSON.stringify(warnings)).toContain('"serverId":"flaky"');
      expect(JSON.stringify(warnings)).not.toContain("search_documents");
      expect(JSON.stringify(warnings)).not.toContain("unauthorized");
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
          mcpServers: [
            {
              id: "flaky",
              name: "Flaky",
              url: flaky.url,
              cacheToolsList: false,
            },
          ],
        }),
        [{ kind: "mcp", id: "flaky", optional: true }],
      );
      try {
        const flakySrv = prepared.mcpServers[0]!;
        await flakySrv.listTools(); // fine — only tools/call 500s
        const result = await flakySrv.callToolResult!("flaky__search_documents", {
          query: "x",
        });
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
    const strict = startTestMcpServer({
      serverErrorForMethods: ["tools/call"],
    });
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            {
              id: "docs-strict",
              name: "Docs",
              url: strict.url,
              cacheToolsList: false,
            },
          ],
        }),
        [{ kind: "mcp", id: "docs-strict" }],
      );
      try {
        await prepared.mcpServers[0]!.listTools(); // fine — only tools/call 500s
        await expect(
          prepared.mcpServers[0]!.callTool("docs-strict__search_documents", {
            query: "x",
          }),
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
    const flaky = startTestMcpServer({
      unauthorizedForMethods: ["tools/list"],
    });
    const healthy = startTestMcpServer();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            {
              id: "flaky",
              name: "Flaky",
              url: flaky.url,
              cacheToolsList: false,
            },
            {
              id: "docs",
              name: "Docs",
              url: healthy.url,
              cacheToolsList: false,
            },
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
          const tools = await getAllMcpTools({
            mcpServers: prepared.mcpServers,
          });
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
    const originalEnv = process.env;
    process.env = {};
    let opengeniDefault: ReturnType<typeof getSettings>["mcpServers"][number] | undefined;
    try {
      opengeniDefault = getSettings().mcpServers.find((server) => server.id === "opengeni");
    } finally {
      process.env = originalEnv;
    }
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

  test("does not reuse an SDK-global tools-list across attempt-scoped allowedTools", async () => {
    const registryId = `scoped_${crypto.randomUUID().replaceAll("-", "_")}`;
    let remoteLists = 0;
    const localServer = (): MCPServer => ({
      name: `inner-${crypto.randomUUID()}`,
      cacheToolsList: true,
      async connect() {},
      async close() {},
      async listTools() {
        remoteLists += 1;
        return [
          {
            name: "read_records",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: "delete_records",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ];
      },
      async callTool() {
        return { content: [{ type: "text", text: "ok" }] };
      },
      async invalidateToolsCache() {},
    });
    const toolNamesFor = async (allowedTools: string[]): Promise<string[]> => {
      const prepared = await prepareAgentTools(
        testSettings({
          mcpServers: [
            {
              id: registryId,
              name: "Attempt-scoped server",
              url: "https://attempt-scoped.example.test/mcp",
              cacheToolsList: true,
              allowedTools,
            },
          ],
        }),
        [{ kind: "mcp", id: registryId }],
        {
          accountId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          sessionId: "33333333-3333-4333-8333-333333333333",
          turnId: "44444444-4444-4444-8444-444444444444",
          attemptId: crypto.randomUUID(),
          executionGeneration: 1,
          localMcpServers: [{ id: registryId, server: localServer() }],
        },
      );
      try {
        return (await getAllMcpTools({ mcpServers: prepared.mcpServers }))
          .map((tool) => tool.name)
          .sort();
      } finally {
        await prepared.close();
      }
    };

    expect(await toolNamesFor(["read_records", "delete_records"])).toEqual([
      prefixedMcpToolName(registryId, "delete_records"),
      prefixedMcpToolName(registryId, "read_records"),
    ]);
    expect(await toolNamesFor(["read_records"])).toEqual([
      prefixedMcpToolName(registryId, "read_records"),
    ]);
    expect(remoteLists).toBe(2);
  });

  test("does not reuse an SDK-global list across in-process attempt definitions", async () => {
    const toolNamesFor = async (modelName: string): Promise<string[]> => {
      const prepared = await prepareAgentTools(testSettings(), [], {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: crypto.randomUUID(),
        executionGeneration: 1,
        attemptToolDefinitions: [
          {
            identity: { serverId: "attempt", toolName: modelName },
            modelName,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            source: "mcp",
            approval: "none",
            execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
          },
        ],
      });
      try {
        return (await getAllMcpTools({ mcpServers: prepared.mcpServers })).map((tool) => tool.name);
      } finally {
        await prepared.close();
      }
    };

    expect(await toolNamesFor("attempt_alpha")).toEqual(["attempt_alpha"]);
    expect(await toolNamesFor("attempt_beta")).toEqual(["attempt_beta"]);
  });

  test("routes selected local MCP adapters through prefixing, bounds, connection identity, and cancellation", async () => {
    const connectionId = "11111111-2222-4333-8444-555555555555";
    let connected = 0;
    let closed = 0;
    let observedSignal: AbortSignal | undefined;
    const local: MCPServer = {
      name: "local-openapi",
      cacheToolsList: true,
      async connect() {
        connected += 1;
      },
      async close() {
        closed += 1;
      },
      async listTools() {
        return [
          {
            name: "list_items",
            description: "List items.",
            inputSchema: { type: "object", properties: {}, required: [] },
          },
        ];
      },
      async callTool(_name, _args, _meta, options) {
        observedSignal = options?.signal;
        return { content: [{ type: "text", text: "ok" }] };
      },
      async invalidateToolsCache() {},
    };
    let remoteFetchCalled = false;
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "inventory_api",
            name: "Inventory API",
            url: "https://inventory.example.test/",
            cacheToolsList: true,
            connectionRef: {
              connectionId,
              providerDomain: "inventory.example.test",
              kind: "oauth2",
              subjectScope: "workspace",
            },
          },
        ],
      }),
      [{ kind: "mcp", id: "inventory_api" }],
      {
        localMcpServers: [
          {
            id: "inventory_api",
            server: local,
            resolvedConnectionId: connectionId,
          },
        ],
        mcpFetchImpl: async () => {
          remoteFetchCalled = true;
          throw new Error("local adapters must not use the remote MCP transport");
        },
      },
    );
    try {
      expect(connected).toBe(1);
      expect(remoteFetchCalled).toBe(false);
      expect(prepared.resolvedMcpConnectionIds.get("inventory_api")).toBe(connectionId);
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["inventory_api__list_items"]);
      const controller = new AbortController();
      await prepared.mcpServers[0]!.callTool("inventory_api__list_items", {}, null, {
        signal: controller.signal,
      });
      expect(observedSignal).toBe(controller.signal);
    } finally {
      await prepared.close();
    }
    expect(closed).toBe(1);
  });

  test("rejects duplicate, unregistered, and connection-mismatched local MCP adapters", async () => {
    const settings = testSettings({
      mcpServers: [
        {
          id: "local_api",
          url: "https://local.example.test/",
          connectionRef: {
            connectionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            providerDomain: "local.example.test",
          },
        },
      ],
    });
    const local = fakeMcpServer("local");
    await expect(
      prepareAgentTools(settings, [{ kind: "mcp", id: "local_api" }], {
        localMcpServers: [
          { id: "local_api", server: local },
          { id: "local_api", server: local },
        ],
      }),
    ).rejects.toThrow("Duplicate local MCP server id");
    await expect(
      prepareAgentTools(settings, [{ kind: "mcp", id: "local_api" }], {
        localMcpServers: [{ id: "missing", server: local }],
      }),
    ).rejects.toThrow("not registered in settings");
    await expect(
      prepareAgentTools(settings, [{ kind: "mcp", id: "local_api" }], {
        localMcpServers: [
          {
            id: "local_api",
            server: local,
            resolvedConnectionId: "ffffffff-1111-4222-8333-444444444444",
          },
        ],
      }),
    ).rejects.toThrow("connection identity changed");
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

function editableArtifactAttemptToolCatalog() {
  return createAttemptToolEnvironment({
    scope: {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 1,
    },
    generation: 1,
    definitions: [
      ...Object.entries(EDITABLE_ARTIFACT_MCP_CODEMODE_PATHS).map(([toolName, codemodePath]) => ({
        identity: { serverId: "opengeni", toolName },
        modelName: `opengeni__${toolName}`,
        codemodePath,
        inputSchema: { type: "object", additionalProperties: false },
        source: "opengeni" as const,
        approval: "none" as const,
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
          structuredContent: { ok: true },
        }),
      })),
      ...["artifacts_create", "artifacts_get_source", "artifacts_publish"].map((toolName) => ({
        identity: { serverId: "opengeni", toolName },
        modelName: `opengeni__${toolName}`,
        codemodePath: ["opengeni", toolName],
        inputSchema: { type: "object", additionalProperties: false },
        source: "opengeni" as const,
        approval: "none" as const,
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
          structuredContent: { ok: true },
        }),
      })),
    ],
  }).catalog;
}

describe("runtime Skill activation", () => {
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
  const emptyManifest = new Manifest({
    root: "/workspace",
    entries: {},
    environment: {},
  });

  test("without explicit activation the domain Skill index is empty", () => {
    const source = composeRuntimeSkills([]).lazySource;
    expect((source.source as { type: string }).type).toBe("dir");
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    expect(index).toEqual([]);
  });

  test("artifact skills join the index when their canonical tool surface is available", () => {
    const composition = composeRuntimeSkills([], {
      editableArtifacts: true,
      sites: false,
      videoGeneration: false,
    });
    const source = composition.lazySource;
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    expect(index.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "opengeni-spreadsheets",
        "opengeni-documents",
        "opengeni-presentations",
      ]),
    );
    const sourceDir = source.source as {
      type: string;
      children: Record<string, any>;
    };
    expect(sourceDir.children["opengeni-spreadsheets"].type).toBe("local_dir");
    expect(composition.selections).toContainEqual(
      expect.objectContaining({
        id: "native-tool:opengeni-spreadsheets",
        name: "opengeni-spreadsheets",
        source: "native_tool",
      }),
    );
  });

  test("the bundled Site Skill follows the exact executable attempt catalog", () => {
    const enabled = composeRuntimeSkills([], {
      editableArtifacts: false,
      sites: true,
      videoGeneration: false,
    });
    const index = enabled.lazySource.getIndex?.(emptyManifest, ".agents") ?? [];
    expect(index.map((entry) => entry.name)).toContain("opengeni-sites");
    expect(enabled.selections).toContainEqual({
      id: "native-tool:opengeni-sites",
      name: "opengeni-sites",
      source: "native_tool",
      version: null,
      contentSha256: null,
      reason: "bundled Site authoring skill",
    });
    expect(
      indexedSkillNames(
        buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), [], {
          attemptToolCatalog: editableArtifactAttemptToolCatalog(),
        }),
        emptyManifest,
      ),
    ).toContain("opengeni-sites");
    expect(
      indexedSkillNames(
        buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), []),
        emptyManifest,
      ),
    ).not.toContain("opengeni-sites");
  });

  test("does not advertise the worker-bundled Site Skill on Connected Machine attempts", () => {
    for (const settings of [
      testSettings({ sandboxBackend: "selfhosted" }),
      testSettings({ sandboxBackend: "docker" }),
    ]) {
      expect(
        indexedSkillNames(
          buildOpenGeniAgent(settings, [], {
            activeSandboxBackend: "selfhosted",
            sandboxWorkspaceRoot: "/srv/opengeni-connected-machine",
          }),
          emptyManifest,
        ),
      ).not.toContain("opengeni-sites");
    }
  });

  test("artifact skills follow the exact tool catalog, independently of local runtime support", () => {
    const settings = testSettings({ sandboxBackend: "docker" });
    expect(() =>
      buildOpenGeniAgent(settings, [], {
        artifactRuntimeAvailable: true,
        sandboxEnvironment: {},
      }),
    ).toThrow("artifactRuntimeAvailable requires absolute");

    const runtimeOnlyAgent = buildOpenGeniAgent(settings, [], {
      artifactRuntimeAvailable: true,
      sandboxEnvironment: {
        OPENGENI_ARTIFACT_RUNTIME_MANIFEST: "/opt/opengeni/artifacts/installation.json",
        OPENGENI_ARTIFACT_TOOL_ENTRY: "/opt/opengeni/artifacts/skill-facade-entry.mjs",
      },
    });
    expect(indexedSkillNames(runtimeOnlyAgent, emptyManifest)).not.toContain("opengeni-documents");

    const catalog = editableArtifactAttemptToolCatalog();
    expect(hasCanonicalEditableArtifactToolSurface(catalog)).toBe(true);
    const agent = buildOpenGeniAgent(settings, [], {
      attemptToolCatalog: catalog,
    });
    expect(indexedSkillNames(agent, emptyManifest)).toContain("opengeni-documents");

    const incompleteCatalog = {
      ...catalog,
      entries: catalog.entries.slice(1),
    };
    expect(hasCanonicalEditableArtifactToolSurface(incompleteCatalog)).toBe(false);
  });

  function indexedSkillNames(agent: unknown, manifest: Manifest): string[] {
    const skillsCapability = (
      (agent as any).capabilities as Array<{
        type: string;
        lazyFrom?: {
          getIndex?: (manifest: unknown, skillsPath: string) => Array<{ name: string }>;
        };
      }>
    ).find((capability) => capability.type === "skills");
    return (
      skillsCapability?.lazyFrom?.getIndex?.(manifest, ".agents").map((entry) => entry.name) ?? []
    );
  }

  test("artifact runtime doctor blocks the agent before an unavailable image can be used", async () => {
    const hooks = sandboxArtifactRuntimeDoctorHooks({
      OPENGENI_ARTIFACT_RUNTIME_MANIFEST: "/opt/opengeni/artifact-runtime/installation.json",
      OPENGENI_ARTIFACT_TOOL_ENTRY: "/opt/opengeni/artifact-runtime/skill-facade-entry.mjs",
    });
    const commands: string[] = [];
    await runBeforeAgentStartHooks(
      {
        execCommand: async ({ cmd }: { cmd: string }) => {
          commands.push(cmd);
          return { exitCode: 0, output: '{"target":"linux-x64-gnu"}' };
        },
      } as any,
      hooks,
      { environment: {} },
    );
    expect(commands).toEqual([
      "'/opt/opengeni/artifact-runtime/opengeni-artifact-runtime.mjs' doctor --json",
    ]);

    await expect(
      runBeforeAgentStartHooks(
        {
          execCommand: async () => ({
            exitCode: 1,
            output: "runtime unavailable",
          }),
        } as any,
        hooks,
        { environment: {} },
      ),
    ).rejects.toThrow("Artifact runtime doctor failed");
  });

  test("credential hook resolution validates every id and deduplicates first-seen hooks", async () => {
    const hooks = sandboxLifecycleHooksForIds([
      "azure-cli-login",
      "azure-cli-login",
      "azure-cli-login",
    ]);
    const commands: string[] = [];
    await runBeforeAgentStartHooks({} as any, hooks, {
      environment: {
        AZURE_CLIENT_ID: "client",
        AZURE_CLIENT_SECRET: "secret",
        AZURE_TENANT_ID: "tenant",
      },
      commandRunner: async (_session, { cmd }) => {
        commands.push(cmd);
        return { exitCode: 0, output: "" };
      },
    });
    expect(commands).toEqual([azureCliLoginCommand()]);
    expect(() =>
      sandboxLifecycleHooksForIds(["azure-cli-login", "unknown", "azure-cli-login"]),
    ).toThrow("Unknown sandbox lifecycle hook unknown");
  });

  test("an explicit curated library selection is materialized and indexed", () => {
    const entry = listSkillLibraryEntries().find(
      (candidate) => candidate.id === "azure-verified-modules",
    );
    expect(entry).toBeDefined();
    const loaded = loadSkillLibrarySkill("azure-verified-modules", entry?.version);
    const source = composeRuntimeSkills([installedActivation(loaded)]).lazySource;
    const sourceDir = source.source as {
      type: string;
      children: Record<string, any>;
    };
    expect(sourceDir.children[loaded.skill.name].type).toBe("dir");
    expect(sourceDir.children[loaded.skill.name].children["SKILL.md"].content).toContain(
      "Azure Verified Modules",
    );
    expect((source.getIndex?.(emptyManifest, ".agents") ?? []).map((item) => item.name)).toContain(
      "azure-verified-modules",
    );
  });

  test("the document parser guidance is an exact opt-in curated artifact", () => {
    const loaded = loadSkillLibrarySkill("document-parsing", "1.0.0");
    expect(loaded.entry).toMatchObject({
      category: "documents",
      license: "MIT",
      contentSha256: "5494b5bbb1629001dad8ab823afb2401efc7a6e76679644d211df8a5164f9d1a",
    });
    expect(loaded.skill.files).toEqual([
      expect.objectContaining({
        path: "SKILL.md",
        content: expect.stringContaining("preinstalled `anydoc` CLI"),
      }),
    ]);
  });

  test("pack skills join the explicit skill index", () => {
    const source = composeRuntimeSkills([packActivation(infraSkill)]).lazySource;
    const sourceDir = source.source as {
      type: string;
      children: Record<string, any>;
    };
    expect(sourceDir.type).toBe("dir");
    // Pack skill content is carried in-memory from the manifest.
    expect(sourceDir.children["infra-ops"].type).toBe("dir");
    expect(sourceDir.children["infra-ops"].children["SKILL.md"].content).toContain("# Infra ops");
    expect(sourceDir.children["infra-ops"].children.references.children["runbook.md"].content).toBe(
      "Runbook.",
    );
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    const names = index.map((entry) => entry.name);
    expect(names).toContain("infra-ops");
    const infra = index.find((entry) => entry.name === "infra-ops");
    expect(infra?.description).toBe("Operate workspace infrastructure.");
    expect(infra?.path).toBe("infra-ops");
  });

  test("an explicit pack skill description wins over SKILL.md frontmatter", () => {
    const source = composeRuntimeSkills([
      packActivation({ ...infraSkill, description: "Explicit description." }),
    ]).lazySource;
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    expect(index.find((entry) => entry.name === "infra-ops")?.description).toBe(
      "Explicit description.",
    );
  });

  test("a Pack may explicitly contribute Checkov like any other Skill", () => {
    const source = composeRuntimeSkills([
      packActivation({
        name: "checkov",
        files: [
          {
            path: "SKILL.md",
            content: "---\ndescription: Pack-provided checkov.\n---\n",
          },
        ],
      }),
    ]).lazySource;
    const sourceDir = source.source as {
      type: string;
      children: Record<string, any>;
    };
    expect(sourceDir.children.checkov.type).toBe("dir");
    const index = source.getIndex?.(emptyManifest, ".agents") ?? [];
    const checkovEntries = index.filter((entry) => entry.name === "checkov");
    expect(checkovEntries).toHaveLength(1);
    expect(checkovEntries[0]?.description).toBe("Pack-provided checkov.");
  });

  test("a Pack owner wins only when it owns the identical installed artifact", () => {
    const loaded = loadSkillLibrarySkill("azure-verified-modules");
    const artifact = runtimeArtifact(loaded.skill);
    const composition = composeRuntimeSkills([
      installedActivation(loaded),
      {
        source: "pack",
        id: `pack:solution:${artifact.name}`,
        artifact,
        reason: "owned by solution Pack",
      },
    ]);
    const source = composition.lazySource;
    const entries = (source.getIndex?.(emptyManifest, ".agents") ?? []).filter(
      (entry) => entry.name === loaded.skill.name,
    );
    expect(entries).toHaveLength(1);
    expect(composition.selections).toContainEqual(
      expect.objectContaining({
        id: `pack:solution:${artifact.name}`,
        source: "pack",
        contentSha256: loaded.entry.contentSha256,
      }),
    );
  });

  test("rejects divergent duplicate Skills instead of using source precedence to hide drift", () => {
    const loaded = loadSkillLibrarySkill("azure-verified-modules");
    expect(() =>
      composeRuntimeSkills([
        installedActivation(loaded),
        packActivation({
          name: loaded.skill.name,
          description: "Divergent Pack override.",
          files: [{ path: "SKILL.md", content: "# Divergent Pack override\n" }],
        }),
      ]),
    ).toThrow(`Conflicting Skill definitions for "${loaded.skill.name}"`);
  });

  test("rejects unsafe activated Skill content instead of mounting it", () => {
    expect(() =>
      composeRuntimeSkills([
        packActivation({
          name: "bad",
          files: [
            { path: "SKILL.md", content: "x" },
            { path: "../escape.md", content: "x" },
          ],
        }),
      ]),
    ).toThrow("Invalid Skill file path");
    expect(() =>
      composeRuntimeSkills([
        packActivation({
          name: "no-entry",
          files: [{ path: "references/only.md", content: "x" }],
        }),
      ]),
    ).toThrow("missing a top-level SKILL.md");
    expect(() =>
      composeRuntimeSkills([
        packActivation({
          name: "dup",
          files: [{ path: "SKILL.md", content: "a" }],
        }),
        packActivation({
          name: "dup",
          files: [{ path: "SKILL.md", content: "b" }],
        }),
      ]),
    ).toThrow('Conflicting Skill definitions for "dup"');
    expect(() =>
      composeRuntimeSkills([
        packActivation({
          name: "bad/name",
          files: [{ path: "SKILL.md", content: "x" }],
        }),
      ]),
    ).toThrow("Invalid Skill name");
  });

  test("buildOpenGeniAgent feeds explicit activations through the SDK Skills capability", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), [], {
      skillActivations: [packActivation(infraSkill)],
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
    // Without explicit Skills, the capability retains an empty in-memory
    // source so repository discovery can still compose.
    const plainAgent = buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), []);
    const plainCapability = (
      (plainAgent as any).capabilities as Array<{
        type: string;
        lazyFrom?: { source: { type: string } };
      }>
    ).find((capability) => capability.type === "skills");
    expect(plainCapability?.lazyFrom?.source.type).toBe("dir");
  });

  test("buildOpenGeniAgent exposes secret-free curated skill provenance", () => {
    const loaded = loadSkillLibrarySkill("azure-verified-modules");
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), [], {
      skillActivations: [installedActivation(loaded)],
    });
    expect(effectiveSkillSelectionsForAgent(agent)).toContainEqual({
      id: `skill:${loaded.entry.id}`,
      name: loaded.entry.name,
      source: "installation",
      version: loaded.entry.version,
      contentSha256: loaded.entry.contentSha256,
      reason: "enabled workspace capability installation",
    });
  });

  test("installed artifact identity is verified before materialization", () => {
    const loaded = loadSkillLibrarySkill("azure-verified-modules");
    expect(() =>
      composeRuntimeSkills([{ ...installedActivation(loaded), contentSha256: "0".repeat(64) }]),
    ).toThrow("Installed Skill artifact hash mismatch");
  });

  test("higher-precedence ownership cannot hide an invalid installed artifact", () => {
    const loaded = loadSkillLibrarySkill("azure-verified-modules");
    const artifact = runtimeArtifact(loaded.skill);
    expect(() =>
      composeRuntimeSkills([
        { ...installedActivation(loaded), contentSha256: "0".repeat(64) },
        {
          source: "session",
          id: `session:${artifact.name}`,
          artifact,
          reason: "selected for the exact session",
        },
      ]),
    ).toThrow("Installed Skill artifact hash mismatch");
  });
});

function runtimeArtifact(skill: {
  name: string;
  description: string;
  files: readonly { path: string; content: string }[];
}) {
  return {
    name: skill.name,
    description: skill.description,
    files: skill.files.map((file) => ({
      path: file.path,
      content: file.content,
    })),
  };
}

function installedActivation(loaded: ReturnType<typeof loadSkillLibrarySkill>) {
  return {
    source: "installation" as const,
    id: `skill:${loaded.entry.id}`,
    artifact: runtimeArtifact(loaded.skill),
    version: loaded.entry.version,
    contentSha256: loaded.entry.contentSha256,
    reason: "enabled workspace capability installation",
  };
}

function packActivation(artifact: {
  name: string;
  description?: string | null;
  files: readonly { path: string; content: string }[];
}) {
  return {
    source: "pack" as const,
    id: `pack:test:${artifact.name}`,
    artifact,
    reason: "owned by test Pack",
  };
}

describe("curated skill-library artifact integrity", () => {
  function withArtifact(run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "opengeni-skill-library-"));
    try {
      mkdirSync(join(root, "references"));
      writeFileSync(join(root, "SKILL.md"), "# Reviewed skill\n", "utf8");
      writeFileSync(join(root, "references", "runbook.md"), "Runbook bytes.\n", "utf8");
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function baseline(root: string): string {
    return readSkillLibraryArtifact(root).contentSha256;
  }

  test("hashes and verifies every recursively materialized file", () => {
    withArtifact((root) => {
      const artifact = readSkillLibraryArtifact(root);
      expect(artifact.files.map((file) => file.path)).toEqual([
        "SKILL.md",
        "references/runbook.md",
      ]);
      expect(verifySkillLibraryArtifact(root, artifact.contentSha256)).toEqual(artifact);
    });
  });

  test("rejects an added file under an unchanged reviewed artifact", () => {
    withArtifact((root) => {
      const expected = baseline(root);
      writeFileSync(join(root, "references", "injected.md"), "Unreviewed guidance.\n", "utf8");
      expect(() => verifySkillLibraryArtifact(root, expected)).toThrow(/artifact hash mismatch/);
    });
  });

  test("rejects a modified file under a reviewed artifact", () => {
    withArtifact((root) => {
      const expected = baseline(root);
      writeFileSync(join(root, "references", "runbook.md"), "Changed guidance.\n", "utf8");
      expect(() => verifySkillLibraryArtifact(root, expected)).toThrow(/artifact hash mismatch/);
    });
  });

  test("rejects a deleted file under a reviewed artifact", () => {
    withArtifact((root) => {
      const expected = baseline(root);
      rmSync(join(root, "references", "runbook.md"));
      expect(() => verifySkillLibraryArtifact(root, expected)).toThrow(/artifact hash mismatch/);
    });
  });

  test("rejects unsafe paths and symbolic links before hashing", () => {
    withArtifact((root) => {
      writeFileSync(join(root, "unsafe\\path.md"), "Unsafe path.\n", "utf8");
      expect(() => readSkillLibraryArtifact(root)).toThrow(/unsafe path/);
    });

    withArtifact((root) => {
      symlinkSync("SKILL.md", join(root, "linked.md"));
      expect(() => readSkillLibraryArtifact(root)).toThrow(/symbolic link/);
    });
  });
});

describe("portable skill artifact validation", () => {
  test("normalizes, sorts, and fingerprints the complete artifact", () => {
    const artifact = buildPortableSkillArtifact([
      { path: "references/runbook.md", content: "Runbook.\n" },
      {
        path: "SKILL.md",
        content:
          "---\nname: incident-response\ndescription: >-\n  Triage incidents and\n  preserve evidence.\n---\n# Incident response\n",
      },
    ]);
    expect(artifact).toMatchObject({
      name: "incident-response",
      description: "Triage incidents and preserve evidence.",
      totalBytes: expect.any(Number),
      contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(artifact.files.map((file) => file.path)).toEqual(["SKILL.md", "references/runbook.md"]);
  });

  test("rejects path traversal, duplicate files, missing metadata, and size overflow", () => {
    const validMarkdown = "---\nname: safe\ndescription: Safe guidance.\n---\n";
    expect(() =>
      buildPortableSkillArtifact([
        { path: "SKILL.md", content: validMarkdown },
        { path: "../escape.md", content: "x" },
      ]),
    ).toThrow("unsafe path");
    expect(() =>
      buildPortableSkillArtifact([
        { path: "SKILL.md", content: validMarkdown },
        { path: "SKILL.md", content: validMarkdown },
      ]),
    ).toThrow("duplicate file path");
    expect(() =>
      buildPortableSkillArtifact([{ path: "SKILL.md", content: "# Missing\n" }]),
    ).toThrow("must declare a safe name");
    expect(() =>
      buildPortableSkillArtifact([
        { path: "SKILL.md", content: validMarkdown },
        {
          path: "large.txt",
          content: "x".repeat(PORTABLE_SKILL_MAX_FILE_BYTES + 1),
        },
      ]),
    ).toThrow("file exceeds");
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
    const userMessage = {
      type: "message",
      role: "user",
      content: "do the thing",
    } as any;
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

  test("base model projection inspects only the suffix appended to a huge immutable prefix", async () => {
    let idReads = 0;
    const prefix = Array.from({ length: 100_000 }, (_, index) => ({
      get id() {
        idReads += 1;
        return `msg_${index}`;
      },
      type: "message",
      role: "user",
      content: `history ${index}`,
    }));
    const filter = baseModelInputFilterForSettings(testSettings());
    const run = async (input: Array<Record<string, unknown>>) =>
      await filter({
        modelData: { input: input as never },
        agent: {} as never,
        context: undefined,
      });

    const first = await run(prefix);
    expect(first.input).toHaveLength(prefix.length);
    expect(idReads).toBe(prefix.length);

    const appended = {
      get id() {
        idReads += 1;
        return "msg_appended";
      },
      type: "message",
      role: "user",
      content: "new suffix",
    };
    const beforeSecond = idReads;
    const second = await run([...prefix, appended]);

    expect(second.input).toHaveLength(prefix.length + 1);
    expect(idReads - beforeSecond).toBe(1);
    expect("id" in (second.input.at(-1) as object)).toBe(false);

    const replacementFirst = {
      get id() {
        idReads += 1;
        return "msg_replacement";
      },
      type: "message",
      role: "user",
      content: "replacement prefix",
    };
    const replacement = await run([replacementFirst, ...prefix.slice(1), appended]);
    expect((replacement.input[0] as { content?: unknown }).content).toBe("replacement prefix");
    expect("id" in (replacement.input[0] as object)).toBe(false);
  });

  test("callModelInputFilterForSettings always restores generic-dispatch provider history", async () => {
    const originalArguments = JSON.stringify({
      name: "connected_tools__weather",
      arguments: { city: "Oslo" },
    });
    const internal = {
      type: "function_call",
      callId: "lazy-1",
      name: "connected_tools__weather",
      arguments: JSON.stringify({ city: "Oslo" }),
      providerData: {
        providerCall: "kept",
        "opengeni.lazy_dispatch.v1": {
          version: 1,
          arguments: originalArguments,
        },
      },
    };
    const filter = callModelInputFilterForSettings(testSettings())!;
    const result = await filter({
      modelData: { input: [internal] as any },
      agent: {} as any,
      context: undefined,
    });

    expect(result.input[0]).toEqual({
      type: "function_call",
      callId: "lazy-1",
      name: "tool_invoke",
      arguments: originalArguments,
      providerData: { providerCall: "kept" },
    });
    expect(internal.name).toBe("connected_tools__weather");
    expect("opengeni.lazy_dispatch.v1" in internal.providerData).toBe(true);
  });

  test("exports the deprecated view_image elision helper as an identity no-op", () => {
    const prefix = [
      { type: "message", role: "user", content: "inspect twice" },
      {
        type: "function_call",
        callId: "view-old",
        name: "view_image",
        arguments: JSON.stringify({ path: "/tmp/a.png" }),
      },
      { type: "function_call_result", callId: "view-old", output: "old" },
      {
        type: "function_call",
        callId: "view-new",
        name: "view_image",
        arguments: JSON.stringify({ path: "/tmp/a.png" }),
      },
      { type: "function_call_result", callId: "view-new", output: "new" },
    ];

    expect(elideSupersededViewImagePairs(prefix)).toBe(prefix);
  });

  test("text-only projection keeps ordinary tool pairs and removes only hosted computer pairs", () => {
    const input = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What is shown?" },
          { type: "input_image", image: "data:image/png;base64,USER" },
        ],
      },
      { type: "reasoning", content: [{ type: "input_text", text: "inspect" }] },
      {
        type: "function_call",
        callId: "view-1",
        name: "view_image",
        arguments: '{"path":"/tmp/a.png"}',
      },
      {
        type: "function_call_result",
        callId: "view-1",
        output: [{ type: "input_image", image: "data:image/png;base64,TOOL" }],
      },
      {
        type: "function_call",
        callId: "metadata-1",
        name: "read_metadata",
        arguments: "{}",
      },
      {
        type: "function_call_result",
        callId: "metadata-1",
        output: [
          { type: "input_text", text: "width=10" },
          { type: "input_image", image: "data:image/png;base64,PREVIEW" },
        ],
      },
      {
        type: "function_call",
        callId: "retained-direct-1",
        name: "view_image",
        arguments: '{"path":"/tmp/retained.png"}',
      },
      {
        type: "function_call_result",
        callId: "retained-direct-1",
        output: {
          type: "retained_artifact",
          artifact: {
            available: false,
            artifactId: "placeholder",
            reason: "pending",
          },
        },
      },
      {
        type: "computer_call",
        callId: "computer-1",
        actions: [{ type: "screenshot" }],
      },
      {
        type: "computer_call_result",
        callId: "computer-1",
        output: {
          type: "computer_screenshot",
          image_url: "data:image/png;base64,SCREEN",
        },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image: "data:image/png;base64,ONLY" }],
      },
    ] as Array<Record<string, unknown>>;
    const durableJson = JSON.stringify(input);

    const projected = projectModelInputForImageSupport(input, false);

    expect(JSON.stringify(projected)).not.toContain("data:image");
    expect(JSON.stringify(projected)).not.toContain("retained_artifact");
    expect(projected.some((item) => item.name === "view_image")).toBe(true);
    expect(projected.some((item) => item.type === "computer_call")).toBe(false);
    expect(projected.find((item) => item.callId === "view-1" && "output" in item)).toEqual({
      type: "function_call_result",
      callId: "view-1",
      output: [
        {
          type: "input_text",
          text: "[Image content omitted because the selected model does not support image input.]",
        },
      ],
    });
    expect(projected.some((item) => item.type === "reasoning")).toBe(true);
    expect(projected.find((item) => item.callId === "metadata-1" && "output" in item)).toEqual({
      type: "function_call_result",
      callId: "metadata-1",
      output: [
        { type: "input_text", text: "width=10" },
        {
          type: "input_text",
          text: "[Image content omitted because the selected model does not support image input.]",
        },
      ],
    });
    expect(JSON.stringify(projected)).toContain("Image content omitted");
    expect(JSON.stringify(input)).toBe(durableJson);
    expect(projectModelInputForImageSupport(input, true)).toBe(input);
    expect(JSON.stringify(projectModelInputForImageSupport(input, true))).toBe(durableJson);
  });

  test("text-only projection does not reapply a tool-output bound", () => {
    const output = "x".repeat(100_000);
    const input = [
      {
        type: "function_call",
        callId: "large-result",
        name: "read_file",
        arguments: "{}",
      },
      {
        type: "function_call_result",
        callId: "large-result",
        output,
      },
    ] as Array<Record<string, unknown>>;

    const projected = projectModelInputForImageSupport(input, false);

    expect(projected[1]?.output).toBe(output);
  });

  test("typed file projection is independent from image support and MIME-specific", () => {
    const input = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image: "data:image/png;base64,IMAGE" },
          {
            type: "input_file",
            file: "data:application/pdf;base64,PDF",
            filename: "kept.pdf",
          },
          {
            type: "input_file",
            file: "data:text/plain;base64,TEXT",
            filename: "hidden.txt",
          },
        ],
      },
    ] as Array<Record<string, unknown>>;

    const projected = projectModelInputForCapabilities(input, {
      supportsImageInput: true,
      inputFileMediaTypes: ["application/pdf"],
    });
    const json = JSON.stringify(projected);

    expect(json).toContain("data:image/png;base64,IMAGE");
    expect(json).toContain("data:application/pdf;base64,PDF");
    expect(json).not.toContain("data:text/plain;base64,TEXT");
    expect(json).toContain("File content omitted");
    expect(JSON.stringify(input)).toContain("data:text/plain;base64,TEXT");
  });

  test("preprojected giant prefixes inspect only new tool-result suffixes", async () => {
    const prefix = Array.from({ length: 100_000 }, (_, index) => ({
      type: "message",
      role: "user",
      content: `history ${index}`,
    }));
    const filter = incrementalModelInputProjectionFilter(
      { supportsImageInput: false, inputFileMediaTypes: [] },
      true,
    )!;
    const run = async (input: Array<Record<string, unknown>>) =>
      await filter({
        modelData: { input: input as never },
        agent: {} as never,
        context: undefined,
      });

    const first = await run(prefix);
    expect(first.input).toBe(prefix);

    const next = [
      ...prefix,
      {
        type: "function_call",
        callId: "image-tool",
        name: "mcp_image",
        arguments: "{}",
      },
      {
        type: "function_call_result",
        callId: "image-tool",
        output: [{ type: "input_image", image: "data:image/png;base64,NEW" }],
      },
    ];
    const second = await run(next);
    const output = second.input as unknown as Array<Record<string, unknown>>;

    expect(output.slice(0, prefix.length)).toEqual(prefix);
    expect(JSON.stringify(output.slice(prefix.length))).not.toContain("data:image");
    expect(JSON.stringify(output.slice(prefix.length))).toContain("Image content omitted");
  });

  test("defensive RunState projection scans its giant prefix only once", async () => {
    let prefixInspections = 0;
    const prefix = Array.from({ length: 100_000 }, (_, index) => ({
      get type() {
        prefixInspections += 1;
        return "message";
      },
      role: "user",
      content: `history ${index}`,
    }));
    const filter = incrementalModelInputProjectionFilter(
      { supportsImageInput: false, inputFileMediaTypes: [] },
      false,
    )!;
    const run = async (input: Array<Record<string, unknown>>) =>
      await filter({
        modelData: { input: input as never },
        agent: {} as never,
        context: undefined,
      });

    const first = await run(prefix);
    expect(first.input).toBe(prefix);
    expect(prefixInspections).toBeGreaterThan(0);
    const firstPassInspections = prefixInspections;

    const next = [
      ...prefix,
      {
        type: "function_call",
        callId: "image-tool",
        name: "mcp_image",
        arguments: "{}",
      },
      {
        type: "function_call_result",
        callId: "image-tool",
        output: [{ type: "input_image", image: "data:image/png;base64,NEW" }],
      },
    ];
    const second = await run(next);

    expect(prefixInspections).toBe(firstPassInspections);
    expect(JSON.stringify(second.input).slice(-500)).not.toContain("data:image");
    expect(JSON.stringify(second.input).slice(-500)).toContain("Image content omitted");
  });

  test("text-only projection runs before context accounting in the real agent loop", async () => {
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
      contextWindowTokens: 20_000,
      contextAutoCompactThresholdTokens: 10_000,
      contextReservedOutputTokens: 0,
    });
    const model = new ScriptedModel("done");
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      supportsImageInput: false,
      hostedWebSearch: false,
    });
    const input = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Describe these if supported." },
          ...["A", "B", "C"].map((value) => ({
            type: "input_image",
            image: `data:image/png;base64,${value.repeat(80_000)}`,
          })),
        ],
      },
    ] as Array<Record<string, unknown>>;

    const result = await runAgentStream(agent, { input: input as any }, settings, {
      contextCompactionRequested: () => false,
    });
    for await (const event of result.toStream()) void event;
    await result.completed;

    expect(model.calls).toBe(1);
    expect(JSON.stringify(model.requests[0]?.input)).not.toContain("data:image");
    expect(JSON.stringify(result.state.history)).toContain("data:image");
    expect(JSON.stringify(input)).toContain("data:image");
  });

  test("reusing a non-lazy agent does not stack model context capture wrappers", async () => {
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
    });
    const model = new ScriptedModel("done");
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
    });
    const requestIndexes: number[] = [];

    for (const input of ["first", "second"]) {
      const result = await runAgentStream(agent, input, settings, {
        onModelVisibleContext: (snapshot) => {
          requestIndexes.push(snapshot.requestIndex);
        },
      });
      for await (const event of result.toStream()) void event;
      await result.completed;
    }

    expect(model.calls).toBe(2);
    expect(requestIndexes).toEqual([1, 1]);
  });

  test("external history ownership borrows frozen input without mutating it", async () => {
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
      openaiProviderItemIds: "strip",
      modelToolOutputTruncationTokens: 100,
    });
    const model = new ScriptedModel("done");
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      supportsImageInput: true,
      hostedWebSearch: false,
    });
    const input = [
      {
        id: "computer-provider-id",
        type: "computer_call",
        callId: "computer-1",
        action: { type: "screenshot" },
        actions: [{ type: "screenshot" }],
      },
      {
        type: "computer_call_result",
        callId: "computer-1",
        output: { type: "computer_screenshot", data: "image" },
      },
      {
        type: "function_call_result",
        callId: "large-result",
        output: { type: "text", text: "x".repeat(100_000) },
      },
    ] as Array<Record<string, unknown>>;
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
      for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
      Object.freeze(value);
    };
    freeze(input);
    const original = JSON.stringify(input);

    const result = await runAgentStream(agent, { input: input as any }, settings);
    for await (const event of result.toStream()) void event;
    await result.completed;

    expect((result.state as any)._originalInput[0]).toBe(input[0]);
    expect(JSON.stringify(input)).toBe(original);
    const wire = model.requests[0]!.input as unknown as Array<Record<string, unknown>>;
    expect(wire[0]).not.toHaveProperty("id");
    expect(wire[0]).not.toHaveProperty("action");
    expect(JSON.stringify(wire[2])).toContain("tokens truncated");
  });

  test("callModelInputFilterForSettings preserves screenshot history prefixes across successive calls", async () => {
    const filter = callModelInputFilterForSettings(
      testSettings({
        openaiProvider: "openai",
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

  test("callModelInputFilterForSettings never performs request-local history trimming", async () => {
    const clientFilter = callModelInputFilterForSettings(
      testSettings({
        openaiProvider: "azure",
        contextWindowTokens: 100,
        contextReservedOutputTokens: 0,
      }),
    )!;
    const serverFilter = callModelInputFilterForSettings(
      testSettings({
        openaiProvider: "openai",
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

    expect(clientOut.input).toEqual(input);
    expect(serverOut.input).toEqual(input);
  });

  test("callModelInputFilterForSettings bounds a multi-megabyte tool result before model input", async () => {
    const filter = callModelInputFilterForSettings(testSettings())!;
    const original = "x".repeat(2_000_000);
    const input = [
      {
        type: "function_call",
        callId: "huge-1",
        name: "sessions_list",
        arguments: "{}",
      },
      {
        type: "function_call_result",
        callId: "huge-1",
        output: { type: "text", text: original },
      },
    ] as any;
    const result = await filter({
      modelData: { input },
      agent: {} as any,
      context: undefined,
    });
    const text = ((result.input[1] as any).output as { text: string }).text;
    expect(text).toContain("tokens truncated");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(50_000);
    expect(((input[1] as any).output as { text: string }).text).toBe(original);
  });

  test("final model-input filtering matches canonical structured persistence bounds", async () => {
    const settings = testSettings({ modelToolOutputTruncationTokens: 100 });
    const filter = callModelInputFilterForSettings(settings)!;
    const output: Record<string, unknown> = {
      type: "界😀".repeat(100_000),
      name: "n".repeat(500_000),
      id: "i".repeat(500_000),
      detail: "d".repeat(500_000),
      ...Object.fromEntries(
        Array.from({ length: 2_000 }, (_, index) => [
          `property-${String(index).padStart(4, "0")}`,
          `value-${index}`,
        ]),
      ),
    };
    let cursor = output;
    for (let depth = 0; depth < 14; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    cursor.payload = "x".repeat(2_000_000);
    const item = {
      type: "function_call_result",
      callId: "structured-parity-1",
      output,
    };
    const input = [item] as any;

    const result = await filter({
      modelData: { input },
      agent: {} as any,
      context: undefined,
    });
    const expected = boundModelToolOutputItem(item, settings.modelToolOutputTruncationTokens);
    expect(result.input[0]).toEqual(expected);
    const serializedProviderItem = JSON.stringify(result.input[0]);
    expect(serializedProviderItem).toBe(JSON.stringify(expected));
    expect(JSON.stringify(result.input[0])).toContain("structured object properties");
    expect(Buffer.byteLength(JSON.stringify(result.input[0]), "utf8")).toBeLessThan(100_000);

    const replayed = await filter({
      modelData: { input: result.input },
      agent: {} as any,
      context: undefined,
    });
    expect(replayed.input).toEqual(result.input);
    expect(JSON.stringify(replayed.input[0])).toBe(serializedProviderItem);
  });

  test("final model-input filtering preserves an established view_image prefix exactly", async () => {
    const filter = callModelInputFilterForSettings(testSettings())!;
    const firstInput = [
      { type: "message", role: "user", content: "inspect it twice" },
      {
        type: "function_call",
        callId: "view-old",
        name: "view_image",
        arguments: JSON.stringify({ path: "/tmp/a.png" }),
      },
      {
        type: "function_call_result",
        callId: "view-old",
        output: [{ type: "input_image", image: "data:image/png;base64,AAAA" }],
      },
    ] as any;
    const firstInputSerialized = JSON.stringify(firstInput);
    const first = await filter({
      modelData: { input: firstInput },
      agent: {} as any,
      context: undefined,
    });
    const secondInput = [
      ...firstInput,
      {
        type: "function_call",
        callId: "view-new",
        name: "view_image",
        arguments: JSON.stringify({ path: "/tmp/a.png" }),
      },
      {
        type: "function_call_result",
        callId: "view-new",
        output: [{ type: "input_image", image: "data:image/png;base64,BBBB" }],
      },
    ] as any;
    const secondInputSerialized = JSON.stringify(secondInput);
    const second = await filter({
      modelData: { input: secondInput },
      agent: {} as any,
      context: undefined,
    });

    expect(JSON.stringify(first.input)).toBe(firstInputSerialized);
    expect(second.input.slice(0, first.input.length)).toEqual(first.input);
    expect(JSON.stringify(second.input.slice(0, first.input.length))).toBe(firstInputSerialized);
    expect(second.input).toHaveLength(first.input.length + 2);
    expect(JSON.stringify(firstInput)).toBe(firstInputSerialized);
    expect(JSON.stringify(secondInput)).toBe(secondInputSerialized);
  });

  test("same-run provider totals add the complete trailing tool result before the next call", async () => {
    let signal: { revision: number; totalTokens: number } | null = null;
    const filter = contextRobustnessFilterForSettings(
      testSettings({
        contextWindowTokens: 20_000,
        contextAutoCompactThresholdTokens: 10_000,
      }),
      {
        throwOnCompactionNeeded: true,
        contextCompactionSignal: () => signal,
      },
    );
    const userOnly = [{ type: "message", role: "user", content: "start" }] as any;
    await filter({
      modelData: { input: userOnly, instructions: "system" },
      agent: {} as any,
      context: undefined,
    });
    signal = { revision: 1, totalTokens: 200 };
    const next = [
      ...userOnly,
      {
        type: "function_call",
        callId: "c1",
        name: "sessions_list",
        arguments: "{}",
      },
      {
        type: "function_call_result",
        callId: "c1",
        output: "界".repeat(11_000),
      },
    ] as any;
    try {
      await filter({
        modelData: { input: next, instructions: "system" },
        agent: {} as any,
        context: undefined,
      });
      throw new Error("expected complete trailing tool output to trigger compaction");
    } catch (error) {
      expect(error).toBeInstanceOf(CompactionNeededError);
      expect((error as CompactionNeededError).signalSource).toBe("provider");
      expect((error as CompactionNeededError).signalTokens).toBeGreaterThan(10_000);
    }
  });

  test("a delayed provider usage signal cannot bind or force estimated compaction", async () => {
    let signal: { revision: number; totalTokens: number } | null = null;
    const filter = contextRobustnessFilterForSettings(
      testSettings({
        contextWindowTokens: 20_000,
        contextAutoCompactThresholdTokens: 10_000,
      }),
      {
        throwOnCompactionNeeded: true,
        contextCompactionSignal: () => signal,
      },
    );
    const first = [{ type: "message", role: "user", content: "start" }] as any;
    await filter({
      modelData: { input: first, instructions: "system" },
      agent: {} as any,
      context: undefined,
    });
    // The SDK can prepare request two before the stream consumer observes the
    // usage frame for request one.
    const second = [
      ...first,
      { type: "message", role: "assistant", content: "first response" },
      { type: "message", role: "user", content: "continue" },
    ] as any;
    await filter({
      modelData: { input: second, instructions: "system" },
      agent: {} as any,
      context: undefined,
    });

    signal = { revision: 1, totalTokens: 200 };
    const third = [
      ...second,
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "🙂".repeat(6_000) }],
      },
      { type: "message", role: "user", content: "continue again" },
    ] as any;
    await expect(
      filter({
        modelData: { input: third, instructions: "system" },
        agent: {} as any,
        context: undefined,
      }),
    ).resolves.toMatchObject({ input: third });
  });

  test("a first call never compacts from estimated instructions and tool schemas", async () => {
    const filter = contextRobustnessFilterForSettings(
      testSettings({
        contextWindowTokens: 10_000,
        contextAutoCompactThresholdTokens: 5_000,
      }),
      { throwOnCompactionNeeded: true },
    );
    const agent = {
      tools: [
        {
          type: "function",
          name: "large_schema",
          description: "d".repeat(24_000),
          parameters: { type: "object", properties: {} },
        },
      ],
    } as any;
    await expect(
      filter({
        modelData: {
          input: [{ type: "message", role: "user", content: "small" }] as any,
          instructions: "system",
        },
        agent,
        context: undefined,
      }),
    ).resolves.toMatchObject({
      input: [{ type: "message", role: "user", content: "small" }],
    });
  });

  test("a first call never compacts from an estimated multilingual tool schema", async () => {
    const filter = contextRobustnessFilterForSettings(
      testSettings({
        contextWindowTokens: 12_000,
        contextAutoCompactThresholdTokens: 7_000,
      }),
      { throwOnCompactionNeeded: true },
    );
    const agent = {
      tools: [
        {
          type: "function",
          name: "multilingual_schema",
          description: "界".repeat(8_000),
          parameters: {
            type: "object",
            properties: { 城市: { type: "string", description: "🙂" } },
          },
        },
      ],
    } as any;
    await expect(
      filter({
        modelData: {
          input: [{ type: "message", role: "user", content: "small" }] as any,
          instructions: "system",
        },
        agent,
        context: undefined,
      }),
    ).resolves.toMatchObject({
      input: [{ type: "message", role: "user", content: "small" }],
    });
  });

  test("first-call accounting excludes MCP schemas deferred behind Codex tool_search", async () => {
    let selectedSchemaAccountingDeferred = true;
    let mandatorySchemaAccountingDeferred = false;
    const selectedMcp = {
      name: "selected",
      cacheToolsList: true,
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      modelToolSchemaTokens: () => (selectedSchemaAccountingDeferred ? 0 : 300_000),
      deferModelToolSchemaAccounting: () => {
        selectedSchemaAccountingDeferred = true;
      },
      modelToolSchemasAreDeferred: () => true,
    } as unknown as MCPServer;
    const mandatoryMcp = {
      name: "opengeni",
      cacheToolsList: true,
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      modelToolSchemaTokens: () => (mandatorySchemaAccountingDeferred ? 0 : 500),
      deferModelToolSchemaAccounting: () => {
        mandatorySchemaAccountingDeferred = true;
      },
      modelToolSchemasAreDeferred: () => false,
    } as unknown as MCPServer;
    const settings = testSettings({
      codexToolSearchEnabled: true,
      contextWindowTokens: 272_000,
      contextAutoCompactThresholdTokens: 244_800,
      webSearchEnabled: false,
    });
    const agent = buildOpenGeniAgent(settings, [], {
      structuredToolTransport: false,
      lazyToolTransport: "codex_native",
      mcpServers: [selectedMcp, mandatoryMcp],
    });
    const filter = contextRobustnessFilterForSettings(settings, {
      throwOnCompactionNeeded: true,
    });

    expect(selectedSchemaAccountingDeferred).toBe(true);
    expect(mandatorySchemaAccountingDeferred).toBe(false);
    await expect(
      filter({
        modelData: {
          input: [{ type: "message", role: "user", content: "small" }] as any,
          instructions: "system",
        },
        agent,
        context: undefined,
      }),
    ).resolves.toMatchObject({
      input: [{ type: "message", role: "user", content: "small" }],
    });
  });

  test("structured sandbox transport no longer selects a lazy-tool protocol", () => {
    let schemaAccountingDeferred = false;
    const selectedMcp = {
      name: "selected",
      cacheToolsList: true,
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      deferModelToolSchemaAccounting: () => {
        schemaAccountingDeferred = true;
      },
    } as unknown as MCPServer;
    buildOpenGeniAgent(
      testSettings({ codexToolSearchEnabled: true, webSearchEnabled: false }),
      [],
      {
        structuredToolTransport: false,
        mcpServers: [selectedMcp],
      },
    );
    expect(schemaAccountingDeferred).toBe(false);
  });

  test("callModelInputFilterForSettings observes an operator compaction request before each model call", async () => {
    let requested = false;
    let polls = 0;
    const filter = callModelInputFilterForSettings(
      testSettings({
        contextWindowTokens: 100_000,
        contextReservedOutputTokens: 0,
      }),
      {
        contextCompactionRequested: async () => {
          polls += 1;
          return requested;
        },
        throwOnCompactionNeeded: true,
      },
    )!;
    const args = {
      modelData: {
        input: [{ type: "message", role: "user", content: "small input" }] as any,
      },
      agent: {} as any,
      context: undefined,
    };

    expect((await filter(args)).input).toEqual(args.modelData.input);
    requested = true;
    try {
      await filter(args);
      throw new Error("expected operator compaction request to stop the model call");
    } catch (error) {
      expect(error).toBeInstanceOf(CompactionNeededError);
      expect((error as CompactionNeededError).trigger).toBe("operator");
      expect((error as CompactionNeededError).signalSource).toBe("operator");
    }
    expect(polls).toBe(2);
  });

  test("buildOpenGeniAgent requests encrypted reasoning content unless disabled", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect((agent as any).modelSettings.providerData).toEqual({
      include: ["reasoning.encrypted_content"],
    });
    const disabled = buildOpenGeniAgent(
      testSettings({
        sandboxBackend: "none",
        openaiReasoningEncryptedContent: false,
      }),
      [],
    );
    expect((disabled as any).modelSettings.providerData).toBeUndefined();
  });
});
