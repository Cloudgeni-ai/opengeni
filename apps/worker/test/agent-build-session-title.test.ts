import { describe, expect, test } from "bun:test";
import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  resolveAgentConfig,
} from "@opengeni/contracts";
import {
  DEFAULT_OPENROUTER_MODEL_ID,
  ORGANIZATION_OPENROUTER_MODEL_ID_PREFIX,
  WORKSPACE_OPENROUTER_MODEL_ID_PREFIX,
  withOrganizationOpenRouterCredential,
  withWorkspaceOpenRouterCredential,
} from "@opengeni/config";
import { resolveTurnModel } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";

import {
  createSessionTitleAttemptToolDefinition,
  routeAllowsSessionTitleRequests,
  SESSION_TITLE_MODEL_TOOL_NAME,
  sessionTitleGenerationOptions,
  sessionTitleReasoningEffort,
  sessionTitleToolPlan,
  shouldRequestMissingSessionTitle,
  startParallelSessionTitleGeneration,
} from "../src/activities/agent-turn/session-title";

const minimalAgentConfig = resolveAgentConfig({
  creator: "api",
  request: { capabilities: { from: "none" } },
  deployment: { unavailable: {}, admissionEnabled: true, defaultForNewSessions: false },
  workspace: { defaults: null, humanInputEnabled: true },
  goal: false,
}).config!;

describe("shouldRequestMissingSessionTitle", () => {
  test("configured sessions title without opting into the first-party title tool", () => {
    expect(
      shouldRequestMissingSessionTitle({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "agent",
        agentConfig: minimalAgentConfig,
        firstPartyMcpTools: [],
        firstPartyMcpPermissions: null,
      }),
    ).toBe(true);
    for (const firstPartyMcpPermissions of [[], ["sessions:read"]] as const) {
      expect(
        shouldRequestMissingSessionTitle({
          title: null,
          titleSource: null,
          agentConfig: minimalAgentConfig,
          firstPartyMcpTools: [],
          firstPartyMcpPermissions,
        }),
      ).toBe(false);
    }
    for (const [title, titleSource] of [
      ["Human title", "user"],
      [AUTOMATIC_SESSION_TITLE_FALLBACK, "user"],
      ["Semantic agent title", "agent"],
    ] as const) {
      expect(
        shouldRequestMissingSessionTitle({
          title,
          titleSource,
          agentConfig: minimalAgentConfig,
          firstPartyMcpTools: [],
          firstPartyMcpPermissions: null,
        }),
      ).toBe(false);
    }
  });

  test("explicit null config preserves the legacy selected-tool admission exactly", () => {
    for (const firstPartyMcpTools of [[], ["set_session_title"]] as const) {
      const input = {
        title: null,
        titleSource: null,
        firstPartyMcpTools,
        firstPartyMcpPermissions: null,
      };
      expect(shouldRequestMissingSessionTitle({ ...input, agentConfig: null })).toBe(
        shouldRequestMissingSessionTitle(input),
      );
    }
  });

  test("an empty linked permission ceiling cannot promote or generate a title", () => {
    const shouldRequestTitle = shouldRequestMissingSessionTitle({
      title: null,
      titleSource: null,
      firstPartyMcpTools: ["set_session_title"],
      firstPartyMcpPermissions: [],
    });
    expect(shouldRequestTitle).toBe(false);
    for (const parallelGenerationAvailable of [true, false]) {
      expect(
        sessionTitleToolPlan({
          tools: [{ kind: "mcp", id: "opengeni" }],
          selectedFirstPartyMcpTools: ["set_session_title"],
          shouldRequestTitle,
          parallelGenerationAvailable,
          routeAllowsTitleRequests: true,
        }),
      ).toMatchObject({ promoteTitleTool: false, generateTitleInParallel: false });
    }
  });
  test("requests semantic titling while the durable title is absent or still the fallback", () => {
    expect(
      shouldRequestMissingSessionTitle({
        title: null,
        titleSource: null,
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(true);
    expect(
      shouldRequestMissingSessionTitle({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "agent",
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(true);
  });

  test("does not advertise an unavailable, unauthorized, or human-locked title tool", () => {
    expect(
      shouldRequestMissingSessionTitle({
        title: null,
        titleSource: null,
        firstPartyMcpTools: [],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(false);
    expect(
      shouldRequestMissingSessionTitle({
        title: null,
        titleSource: null,
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: ["sessions:read"],
      }),
    ).toBe(false);
    expect(
      shouldRequestMissingSessionTitle({
        title: "Human title",
        titleSource: "user",
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(false);
    expect(
      shouldRequestMissingSessionTitle({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "user",
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(false);
    expect(
      shouldRequestMissingSessionTitle({
        title: "Semantic agent title",
        titleSource: "agent",
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(false);
  });
});

describe("sessionTitleToolPlan", () => {
  test("configured titling is runtime-owned without a selected tool or MCP carrier", () => {
    for (const parallelGenerationAvailable of [true, false]) {
      expect(
        sessionTitleToolPlan({
          tools: [],
          agentConfig: minimalAgentConfig,
          selectedFirstPartyMcpTools: [],
          shouldRequestTitle: true,
          parallelGenerationAvailable,
          routeAllowsTitleRequests: true,
        }),
      ).toEqual({
        promoteTitleTool: !parallelGenerationAvailable,
        generateTitleInParallel: parallelGenerationAvailable,
        remoteFirstPartyMcpTools: [],
        preparationIndependentToolNames: parallelGenerationAvailable
          ? []
          : [SESSION_TITLE_MODEL_TOOL_NAME],
      });
    }
  });

  test("configured titling still respects the provider route and missing-title decision", () => {
    for (const [shouldRequestTitle, routeAllowsTitleRequests] of [
      [true, false],
      [false, true],
    ] as const) {
      expect(
        sessionTitleToolPlan({
          tools: [],
          agentConfig: minimalAgentConfig,
          selectedFirstPartyMcpTools: [],
          shouldRequestTitle,
          parallelGenerationAvailable: true,
          routeAllowsTitleRequests,
        }),
      ).toMatchObject({
        promoteTitleTool: false,
        generateTitleInParallel: false,
        remoteFirstPartyMcpTools: [],
        preparationIndependentToolNames: [],
      });
    }
  });

  test("explicit null config preserves the legacy carrier and disclosure plan exactly", () => {
    for (const tools of [[], [{ kind: "mcp", id: "opengeni" }]] as const) {
      for (const parallelGenerationAvailable of [true, false]) {
        const input = {
          tools,
          selectedFirstPartyMcpTools: ["set_session_title", "goal_set"] as const,
          shouldRequestTitle: true,
          parallelGenerationAvailable,
          routeAllowsTitleRequests: true,
        };
        expect(sessionTitleToolPlan({ ...input, agentConfig: null })).toEqual(
          sessionTitleToolPlan(input),
        );
      }
    }
  });

  test("removes automatic titling from the agent loop when parallel generation is available", () => {
    const tools = [
      { kind: "mcp" as const, id: "opengeni" },
      { kind: "mcp" as const, id: "connector", optional: true },
    ];
    expect(
      sessionTitleToolPlan({
        tools,
        selectedFirstPartyMcpTools: ["set_session_title", "goal_set"],
        shouldRequestTitle: true,
        parallelGenerationAvailable: true,
        routeAllowsTitleRequests: true,
      }),
    ).toEqual({
      promoteTitleTool: false,
      generateTitleInParallel: true,
      remoteFirstPartyMcpTools: ["goal_set"],
      preparationIndependentToolNames: [],
    });
    expect(tools).toEqual([
      { kind: "mcp", id: "opengeni" },
      { kind: "mcp", id: "connector", optional: true },
    ]);
  });

  test("retains the serialized local-tool fallback for custom runtimes", () => {
    expect(
      sessionTitleToolPlan({
        tools: [{ kind: "mcp", id: "opengeni" }],
        selectedFirstPartyMcpTools: ["set_session_title", "goal_set"],
        shouldRequestTitle: true,
        parallelGenerationAvailable: false,
        routeAllowsTitleRequests: true,
      }),
    ).toEqual({
      promoteTitleTool: true,
      generateTitleInParallel: false,
      remoteFirstPartyMcpTools: ["goal_set"],
      preparationIndependentToolNames: [SESSION_TITLE_MODEL_TOOL_NAME],
    });
  });

  test("does not grant a missing carrier or change titled-session disclosure", () => {
    expect(
      sessionTitleToolPlan({
        tools: [{ kind: "mcp", id: "connector" }],
        selectedFirstPartyMcpTools: ["set_session_title", "goal_set"],
        shouldRequestTitle: true,
        parallelGenerationAvailable: true,
        routeAllowsTitleRequests: true,
      }),
    ).toEqual({
      promoteTitleTool: false,
      generateTitleInParallel: false,
      remoteFirstPartyMcpTools: ["set_session_title", "goal_set"],
      preparationIndependentToolNames: [],
    });

    expect(
      sessionTitleToolPlan({
        tools: [{ kind: "mcp", id: "opengeni" }],
        selectedFirstPartyMcpTools: ["set_session_title", "goal_set"],
        shouldRequestTitle: false,
        parallelGenerationAvailable: true,
        routeAllowsTitleRequests: true,
      }),
    ).toEqual({
      promoteTitleTool: false,
      generateTitleInParallel: false,
      remoteFirstPartyMcpTools: ["set_session_title", "goal_set"],
      preparationIndependentToolNames: [],
    });
  });
});

describe("managed OpenRouter free route", () => {
  const freeUpstreamModelId = DEFAULT_OPENROUTER_MODEL_ID.slice("openrouter/".length);
  const settings = testSettings({
    sandboxBackend: "none",
    openrouterApiKey: "deployment-openrouter-key",
    modelProvidersJson: "[]",
    resolvedOpenRouterModelsJson: undefined,
  });

  test("skips title requests only on the deployment-funded free route", () => {
    const managedFree = resolveTurnModel(settings, DEFAULT_OPENROUTER_MODEL_ID)!;
    expect(managedFree.provider.kind).toBe("openrouter-managed");
    expect(managedFree.configured.credentialSource.kind).toBe("deployment");
    expect(routeAllowsSessionTitleRequests(managedFree)).toBe(false);

    const workspaceFree = resolveTurnModel(
      withWorkspaceOpenRouterCredential(settings, "workspace-openrouter-key"),
      `${WORKSPACE_OPENROUTER_MODEL_ID_PREFIX}${freeUpstreamModelId}`,
    )!;
    expect(workspaceFree.configured.upstreamModelId).toBe(freeUpstreamModelId);
    expect(workspaceFree.provider.kind).toBe("openrouter-workspace");
    expect(routeAllowsSessionTitleRequests(workspaceFree)).toBe(true);

    const organizationFree = resolveTurnModel(
      withOrganizationOpenRouterCredential(settings, "organization-openrouter-key", [
        { upstreamModelId: freeUpstreamModelId },
      ]),
      `${ORGANIZATION_OPENROUTER_MODEL_ID_PREFIX}${freeUpstreamModelId}`,
    )!;
    expect(organizationFree.configured.upstreamModelId).toBe(freeUpstreamModelId);
    expect(organizationFree.provider.kind).toBe("openrouter-organization");
    expect(routeAllowsSessionTitleRequests(organizationFree)).toBe(true);

    expect(routeAllowsSessionTitleRequests(resolveTurnModel(settings, "gpt-5.6-sol")!)).toBe(true);
    expect(routeAllowsSessionTitleRequests(null)).toBe(true);
  });

  test("an untitled session gets no title sidecar and no title tool", () => {
    const plan = sessionTitleToolPlan({
      tools: [{ kind: "mcp", id: "opengeni" }],
      selectedFirstPartyMcpTools: ["set_session_title", "goal_set"],
      shouldRequestTitle: true,
      parallelGenerationAvailable: true,
      routeAllowsTitleRequests: routeAllowsSessionTitleRequests(
        resolveTurnModel(settings, DEFAULT_OPENROUTER_MODEL_ID),
      ),
    });
    expect(plan).toEqual({
      promoteTitleTool: false,
      generateTitleInParallel: false,
      remoteFirstPartyMcpTools: ["goal_set"],
      preparationIndependentToolNames: [],
    });

    expect(
      sessionTitleToolPlan({
        tools: [{ kind: "mcp", id: "opengeni" }],
        selectedFirstPartyMcpTools: ["set_session_title", "goal_set"],
        shouldRequestTitle: true,
        parallelGenerationAvailable: false,
        routeAllowsTitleRequests: false,
      }),
    ).toEqual(plan);
  });

  test("a titled session keeps ordinary title-tool disclosure", () => {
    expect(
      sessionTitleToolPlan({
        tools: [{ kind: "mcp", id: "opengeni" }],
        selectedFirstPartyMcpTools: ["set_session_title", "goal_set"],
        shouldRequestTitle: false,
        parallelGenerationAvailable: true,
        routeAllowsTitleRequests: false,
      }),
    ).toEqual({
      promoteTitleTool: false,
      generateTitleInParallel: false,
      remoteFirstPartyMcpTools: ["set_session_title", "goal_set"],
      preparationIndependentToolNames: [],
    });
  });
});

describe("startParallelSessionTitleGeneration", () => {
  test("starts immediately and returns a completed title without blocking the caller", async () => {
    let started = false;
    const task = startParallelSessionTitleGeneration({
      generate: async () => {
        started = true;
        return { title: "Parallel session titles", usage: null };
      },
    });

    await Promise.resolve();
    expect(started).toBe(true);
    expect(await task.finish()).toEqual({
      title: "Parallel session titles",
      usage: null,
    });
  });

  test("finish waits for a title request that is still pending", async () => {
    let observedSignal: AbortSignal | null = null;
    let completeGeneration!: (value: { title: string; usage: null }) => void;
    const task = startParallelSessionTitleGeneration({
      generate: async (signal) => {
        observedSignal = signal;
        return await new Promise<{ title: string; usage: null }>((resolve) => {
          completeGeneration = resolve;
        });
      },
    });

    await Promise.resolve();
    const finished = task.finish();
    expect(observedSignal?.aborted).toBe(false);
    completeGeneration({ title: "Quick response title", usage: null });
    expect(await finished).toEqual({ title: "Quick response title", usage: null });
    expect(observedSignal?.aborted).toBe(false);
  });

  test("cancel aborts and joins a title request that is still pending", async () => {
    let observedSignal: AbortSignal | null = null;
    const task = startParallelSessionTitleGeneration({
      generate: async (signal) => {
        observedSignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        return { title: "Too late", usage: null };
      },
    });

    await Promise.resolve();
    await task.cancel();
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe("createSessionTitleAttemptToolDefinition", () => {
  test("exposes the canonical identity and returns the durable normalized result", async () => {
    const updates: string[] = [];
    const definition = createSessionTitleAttemptToolDefinition({
      updateTitle: async (title) => {
        updates.push(title);
        return { updated: true, title: "Normalized topic" };
      },
    });

    expect(definition.identity).toEqual({
      serverId: "opengeni",
      toolName: "set_session_title",
    });
    expect(definition.modelName).toBe(SESSION_TITLE_MODEL_TOOL_NAME);
    expect(definition.approval).toBe("none");

    const result = await definition.execute(
      { title: "  Normalized topic  " },
      {
        operationId: "00000000-0000-4000-8000-000000000001",
        caller: { kind: "model", subjectId: "worker:first-party-mcp" },
      },
    );

    expect(updates).toEqual(["  Normalized topic  "]);
    expect(result.structuredContent).toEqual({
      ok: true,
      updated: true,
      title: "Normalized topic",
    });
  });
});

describe("sessionTitleReasoningEffort", () => {
  const reasoning = (
    runnable: boolean,
    efforts: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh">,
  ) => ({
    reasoning: {
      upstream: "supported" as const,
      runnable,
      efforts,
      defaultEffort: efforts.at(-1) ?? null,
      required: false,
    },
  });

  test("uses the lowest runnable effort regardless of declaration order", () => {
    expect(sessionTitleReasoningEffort(reasoning(true, ["medium", "low"]))).toBe("low");
    expect(sessionTitleReasoningEffort(reasoning(true, ["high", "minimal", "low"]))).toBe(
      "minimal",
    );
    expect(sessionTitleReasoningEffort(reasoning(true, ["xhigh", "none", "medium"]))).toBe("none");
  });

  test("sends no reasoning parameter without a runnable reasoning control", () => {
    expect(sessionTitleReasoningEffort(undefined)).toBeUndefined();
    expect(sessionTitleReasoningEffort(reasoning(false, ["low", "medium"]))).toBeUndefined();
    expect(sessionTitleReasoningEffort(reasoning(true, []))).toBeUndefined();
  });
});

describe("sessionTitleGenerationOptions", () => {
  const resolvedModel = resolveTurnModel(testSettings({ sandboxBackend: "none" }), "gpt-5.6-sol")!;
  const signal = new AbortController().signal;

  test("binds the resolved provider and the model's lowest runnable effort, not the turn's", () => {
    expect(resolvedModel.configured.capabilities?.reasoning).toMatchObject({
      runnable: true,
      defaultEffort: "high",
    });

    const options = sessionTitleGenerationOptions({
      resolvedModel,
      modelName: "gpt-5.6-sol",
      serviceTier: "priority",
      signal,
    });

    expect(options.client).toBe(resolvedModel.client);
    expect(options.provider).toBe(resolvedModel.provider);
    expect(options.model).toBe(resolvedModel.model);
    expect(options.modelName).toBe("gpt-5.6-sol");
    expect(options.serviceTier).toBe("priority");
    expect(options.reasoningEffort).toBe(
      sessionTitleReasoningEffort(resolvedModel.configured.capabilities)!,
    );
    expect(options.reasoningEffort).toBe("low");
    expect(options.signal).toBe(signal);
  });

  test("omits reasoning effort without a runnable reasoning control or a resolved model", () => {
    const capabilities = resolvedModel.configured.capabilities!;
    const withoutRunnableReasoning = sessionTitleGenerationOptions({
      resolvedModel: {
        ...resolvedModel,
        configured: {
          ...resolvedModel.configured,
          capabilities: {
            ...capabilities,
            reasoning: { ...capabilities.reasoning, runnable: false },
          },
        },
      },
      modelName: "gpt-5.6-sol",
      serviceTier: undefined,
      signal,
    });
    expect("reasoningEffort" in withoutRunnableReasoning).toBe(false);
    expect("serviceTier" in withoutRunnableReasoning).toBe(false);

    const unresolved = sessionTitleGenerationOptions({
      resolvedModel: null,
      modelName: "scripted-model",
      serviceTier: null,
      signal,
    });
    expect(unresolved).toEqual({ modelName: "scripted-model", signal });
  });
});
