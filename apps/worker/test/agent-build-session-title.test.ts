import { describe, expect, test } from "bun:test";
import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
} from "@opengeni/contracts";

import {
  createSessionTitleAttemptToolDefinition,
  SESSION_TITLE_MODEL_TOOL_NAME,
  sessionTitleToolPlan,
  shouldRequestMissingSessionTitle,
  startParallelSessionTitleGeneration,
} from "../src/activities/agent-turn/session-title";

describe("shouldRequestMissingSessionTitle", () => {
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

  test("finish aborts and joins a title request that is still pending", async () => {
    let observedSignal: AbortSignal | null = null;
    const task = startParallelSessionTitleGeneration({
      generate: async (signal) => {
        observedSignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        return { title: "Too late", usage: null };
      },
    });

    await Promise.resolve();
    expect(await task.finish()).toBeNull();
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
