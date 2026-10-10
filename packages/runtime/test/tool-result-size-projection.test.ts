import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { MCPServer } from "@openai/agents";
import type { AttemptToolExecutionContext } from "@opengeni/codemode";
import type { AttemptToolIdentity, AttemptToolResult } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { PrefixedMcpServer, prefixedMcpToolName, prepareAgentTools } from "../src";
import { unwrapSdkMcpResultProjection } from "../src/mcp-result-custom-data";
import {
  projectFirstPartyToolResultSizeForModel,
  TOOL_RESULT_SIZE_EXPERIMENT_ENV,
  toolResultSizeExperimentEnabled,
} from "../src/tool-result-size-projection";
import { projectAttemptToolResultForCaller } from "../src/tool-result-spill";

type Json = Record<string, any>;

const VARIABLE_SETS: AttemptToolIdentity = { serverId: "opengeni", toolName: "variable_set_list" };
const ENVIRONMENTS: AttemptToolIdentity = { serverId: "opengeni", toolName: "environment_list" };
const EVENTS: AttemptToolIdentity = { serverId: "opengeni", toolName: "session_events" };
const SESSIONS: AttemptToolIdentity = { serverId: "opengeni", toolName: "sessions_list" };
const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function timestamp(seed: number): string {
  return new Date(Date.UTC(2026, 8, 1) + seed * 3_600_007).toISOString();
}

/** The first-party API's serialization (`json()` in apps/api/src/mcp/server.ts). */
function apiResult(value: unknown): AttemptToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function textOf(result: AttemptToolResult): string {
  const [content] = result.content;
  if (content?.type !== "text") throw new Error("expected one text block");
  return content.text;
}

function context(kind: "model" | "codemode"): AttemptToolExecutionContext {
  return {
    operationId: OPERATION_ID,
    caller: { kind, subjectId: kind === "codemode" ? "codemode:test" : "worker:mcp-model" },
  };
}

// ---- fixtures shaped like the staging outputs ------------------------------
// Staging variable sets: about 95% of variables are at version 1, where
// createdAt === updatedAt. Debug pages repeat one session/workspace per event and
// carry null clientEventId/duplicateOfEventId/duplicateReason on nearly every event.

function variableSetsFixture(sets = 40, variablesPerSet = 7): Json[] {
  return Array.from({ length: sets }, (_unused, setIndex) => ({
    id: uuid(`set-${setIndex}`),
    name: `service-${setIndex}-credentials`,
    scope: setIndex % 3 === 0 ? "workspace" : "organization",
    status: "active",
    accountId: uuid("account"),
    createdAt: timestamp(setIndex),
    updatedAt: timestamp(setIndex + 1),
    variables: Array.from({ length: variablesPerSet }, (_entry, variableIndex) => {
      const seed = setIndex * 100 + variableIndex;
      const rewritten = seed % 20 === 0;
      return {
        name: `SERVICE_${setIndex}_SECRET_${variableIndex}`,
        version: rewritten ? 3 : 1,
        createdAt: timestamp(seed),
        updatedAt: timestamp(rewritten ? seed + 50 : seed),
      };
    }),
    generation: 1 + (setIndex % 4),
    description: setIndex % 5 === 0 ? `Credentials for service ${setIndex}` : null,
    workspaceId: uuid("workspace"),
  }));
}

function variableSetListFixture(): Json {
  const variableSets = variableSetsFixture();
  return { variableSets, environments: structuredClone(variableSets) };
}

function debugPageFixture(events = 12): Json {
  const sessionId = uuid("session");
  const workspaceId = uuid("workspace");
  return {
    mode: "forensic",
    payloadMode: "full",
    direction: "before",
    events: Array.from({ length: events }, (_, index) => ({
      id: uuid(`event-${index}`),
      workspaceId,
      sessionId,
      sequence: 21_163 - index,
      type: index % 2 === 0 ? "agent.toolCall.output" : "system.update.delivered",
      payload: { callId: `call_${index}`, output: `exit 0, ${index} files changed` },
      occurredAt: timestamp(index),
      clientEventId: index === 3 ? "client-3" : null,
      turnId: uuid("turn"),
      turnGeneration: 1,
      turnAttemptId: uuid("attempt"),
      turnAssociation: "current",
      duplicateOfEventId: null,
      duplicateReason: null,
    })),
    coveredSequence: { from: 21_163 - events + 1, to: 21_163 },
    nextAfter: null,
    nextBefore: 21_163 - events,
    hasMore: true,
    truncated: false,
    truncation: { reason: null },
    bytes: 16_351,
    maxBytes: 65_536,
  };
}

/** Rebuild the exact API value from the model copy (the inverse the model can apply). */
function reconstructVariableSetList(compact: Json, canonical: string, alias: string): Json {
  const sets = compact[canonical].map((set: Json) => ({
    ...set,
    variables: set.variables.map((variable: Json) =>
      "createdAt" in variable
        ? variable
        : {
            name: variable.name,
            version: variable.version,
            createdAt: variable.updatedAt,
            updatedAt: variable.updatedAt,
          },
    ),
  }));
  return { [canonical]: sets, [alias]: sets };
}

function reconstructDebugPage(compact: Json, original: Json): Json {
  const { sessionId, workspaceId, ...page } = compact;
  return {
    ...page,
    events: page.events.map((event: Json, index: number) => {
      // Key order is not semantic; compare structurally after restoring values.
      const restored: Json = { ...event, sessionId, workspaceId };
      for (const key of ["clientEventId", "duplicateOfEventId", "duplicateReason"]) {
        if (!(key in restored)) restored[key] = null;
      }
      expect(Object.keys(restored).sort()).toEqual(Object.keys(original.events[index]).sort());
      return restored;
    }),
  };
}

// ---- tests -----------------------------------------------------------------

describe("experiment flag", () => {
  test("is off unless exactly 1", () => {
    expect(toolResultSizeExperimentEnabled({})).toBe(false);
    expect(toolResultSizeExperimentEnabled({ [TOOL_RESULT_SIZE_EXPERIMENT_ENV]: "0" })).toBe(false);
    expect(toolResultSizeExperimentEnabled({ [TOOL_RESULT_SIZE_EXPERIMENT_ENV]: "true" })).toBe(
      false,
    );
    expect(toolResultSizeExperimentEnabled({ [TOOL_RESULT_SIZE_EXPERIMENT_ENV]: "1" })).toBe(true);
  });
});

describe("first-party model projection", () => {
  test("variable_set_list drops the duplicate alias and repeated createdAt, losslessly", () => {
    const original = variableSetListFixture();
    const projected = projectFirstPartyToolResultSizeForModel(VARIABLE_SETS, apiResult(original));
    const compact = JSON.parse(textOf(projected));
    expect(Object.keys(compact)).toEqual(["variableSets"]);
    const variables = compact.variableSets.flatMap((set: Json) => set.variables);
    expect(variables.some((variable: Json) => "createdAt" in variable)).toBe(true);
    for (const variable of variables) {
      if ("createdAt" in variable) expect(variable.createdAt).not.toBe(variable.updatedAt);
      expect(typeof variable.updatedAt).toBe("string");
    }
    expect(reconstructVariableSetList(compact, "variableSets", "environments")).toEqual(original);
  });

  test("environment_list keeps its own canonical key", () => {
    const original = variableSetListFixture();
    const compact = JSON.parse(
      textOf(projectFirstPartyToolResultSizeForModel(ENVIRONMENTS, apiResult(original))),
    );
    expect(Object.keys(compact)).toEqual(["environments"]);
    expect(reconstructVariableSetList(compact, "environments", "variableSets")).toEqual(original);
  });

  test("a differing alias is kept", () => {
    const original = variableSetListFixture();
    original.environments = original.environments.slice(1);
    const compact = JSON.parse(
      textOf(projectFirstPartyToolResultSizeForModel(VARIABLE_SETS, apiResult(original))),
    );
    expect(compact.environments).toEqual(original.environments);
  });

  test("session_events debug pages state one session/workspace and omit null defaults", () => {
    const original = debugPageFixture();
    const compact = JSON.parse(
      textOf(projectFirstPartyToolResultSizeForModel(EVENTS, apiResult(original))),
    );
    expect(compact.sessionId).toBe(original.events[0].sessionId);
    expect(compact.workspaceId).toBe(original.events[0].workspaceId);
    for (const event of compact.events) {
      expect(event).not.toHaveProperty("sessionId");
      expect(event).not.toHaveProperty("workspaceId");
      expect(event).not.toHaveProperty("duplicateReason");
    }
    expect(compact.events[3].clientEventId).toBe("client-3");
    expect(reconstructDebugPage(compact, original)).toEqual(original);
  });

  test("a debug page mixing sessions keeps them per event", () => {
    const original = debugPageFixture(4);
    original.events[2].sessionId = uuid("other-session");
    const compact = JSON.parse(
      textOf(projectFirstPartyToolResultSizeForModel(EVENTS, apiResult(original))),
    );
    expect(compact).not.toHaveProperty("sessionId");
    expect(compact.events.map((event: Json) => event.sessionId)).toEqual(
      original.events.map((event: Json) => event.sessionId),
    );
    expect(compact.workspaceId).toBe(original.events[0].workspaceId);
  });

  test("session_events content views and other first-party tools are only minified", () => {
    const conversation = { view: "conversation", items: [{ role: "user", text: "hi" }] };
    const sessions = { sessions: [{ id: uuid("s"), title: "Report", status: "idle" }] };
    for (const [identity, value] of [
      [EVENTS, conversation],
      [SESSIONS, sessions],
    ] as const) {
      const projected = projectFirstPartyToolResultSizeForModel(identity, apiResult(value));
      expect(textOf(projected)).toBe(JSON.stringify(value));
    }
  });

  test("anything that is not exactly the API's pretty JSON is unchanged", () => {
    const value = variableSetListFixture();
    const unchanged: AttemptToolResult[] = [
      { content: [{ type: "text", text: JSON.stringify(value) }] },
      { content: [{ type: "text", text: `${JSON.stringify(value, null, 2)}\n` }] },
      { content: [{ type: "text", text: 'Session created.\n{\n  "id": 1\n}' }] },
      { ...apiResult(value), isError: true },
      { ...apiResult(value), structuredContent: value },
      { content: [...apiResult(value).content, { type: "text", text: "more" }] },
    ];
    for (const result of unchanged) {
      expect(projectFirstPartyToolResultSizeForModel(VARIABLE_SETS, result)).toBe(result);
    }
    const external = apiResult(value);
    expect(
      projectFirstPartyToolResultSizeForModel(
        { serverId: "github", toolName: "variable_set_list" },
        external,
      ),
    ).toBe(external);
  });

  test("result metadata outside the text block is preserved", () => {
    const result = { ...apiResult(debugPageFixture()), _meta: { trace: "kept" } };
    const projected = projectFirstPartyToolResultSizeForModel(EVENTS, result);
    expect(projected._meta).toEqual({ trace: "kept" });
    expect(textOf(projected).length).toBeLessThan(textOf(result).length);
  });
});

describe("caller seam", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env[TOOL_RESULT_SIZE_EXPERIMENT_ENV];
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[TOOL_RESULT_SIZE_EXPERIMENT_ENV];
    else process.env[TOOL_RESULT_SIZE_EXPERIMENT_ENV] = previous;
  });

  test("flag off: the model receives the exact result", async () => {
    delete process.env[TOOL_RESULT_SIZE_EXPERIMENT_ENV];
    const result = apiResult(variableSetListFixture());
    expect(
      await projectAttemptToolResultForCaller(result, context("model"), undefined, VARIABLE_SETS),
    ).toBe(result);
  });

  test("flag on: the model receives the projection, Codemode the exact result", async () => {
    process.env[TOOL_RESULT_SIZE_EXPERIMENT_ENV] = "1";
    const result = apiResult(variableSetListFixture());
    const exact = textOf(result);
    const codemode = await projectAttemptToolResultForCaller(
      result,
      context("codemode"),
      undefined,
      VARIABLE_SETS,
    );
    expect(codemode).toBe(result);
    const model = await projectAttemptToolResultForCaller(
      result,
      context("model"),
      undefined,
      VARIABLE_SETS,
    );
    expect(textOf(model)).toBe(
      textOf(projectFirstPartyToolResultSizeForModel(VARIABLE_SETS, result)),
    );
    expect(textOf(model).length).toBeLessThan(exact.length);
    expect(textOf(result)).toBe(exact);
  });

  test("flag on: a projection still over 1 MiB spills the exact bytes", async () => {
    process.env[TOOL_RESULT_SIZE_EXPERIMENT_ENV] = "1";
    const original = apiResult({ variableSets: variableSetsFixture(360, 40) });
    const compact = projectFirstPartyToolResultSizeForModel(VARIABLE_SETS, original);
    expect(Buffer.byteLength(textOf(compact))).toBeGreaterThan(1_048_576);
    const spilled: unknown[] = [];
    await projectAttemptToolResultForCaller(
      original,
      context("model"),
      async (input) => {
        spilled.push(input.result);
        return apiResult({ spilled: true });
      },
      VARIABLE_SETS,
    );
    expect(spilled).toEqual([original]);
  }, 30_000);

  test("flag on, prepared first-party MCP: model calls are compact, Codemode calls exact", async () => {
    process.env[TOOL_RESULT_SIZE_EXPERIMENT_ENV] = "1";
    const outputs: Record<string, string> = {
      variable_set_list: textOf(apiResult(variableSetListFixture())),
      session_events: textOf(apiResult(debugPageFixture())),
    };
    const server = (name: string, tools: string[]): MCPServer => ({
      name,
      cacheToolsList: false,
      async connect() {},
      async close() {},
      async listTools() {
        return tools.map((tool) => ({
          name: tool,
          description: tool,
          inputSchema: {
            type: "object" as const,
            properties: {},
            required: [],
            additionalProperties: true,
          },
        }));
      },
      async callTool(tool: string) {
        return [{ type: "text", text: outputs[tool]! }];
      },
      async callToolResult(tool: string) {
        return { content: [{ type: "text", text: outputs[tool]! }] };
      },
      async invalidateToolsCache() {},
    });
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "opengeni",
            name: "Opengeni",
            url: "https://mcp.example.test/og",
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
        localMcpServers: [
          { id: "opengeni", server: server("og-inner", ["variable_set_list", "session_events"]) },
        ],
      },
    );
    try {
      const environment = prepared.attemptToolEnvironment!;
      const catalogDigest = prepared.attemptToolCatalog!.digest;
      const opengeni = prepared.mcpServers.find(
        (candidate) =>
          candidate instanceof PrefixedMcpServer && candidate.registryId === "opengeni",
      )!;
      for (const identity of [VARIABLE_SETS, EVENTS]) {
        const exact = outputs[identity.toolName]!;
        const model = unwrapSdkMcpResultProjection(
          await opengeni.callToolResult!(prefixedMcpToolName("opengeni", identity.toolName), {}),
        ) as AttemptToolResult;
        expect(textOf(model)).toBe(
          textOf(projectFirstPartyToolResultSizeForModel(identity, apiResult(JSON.parse(exact)))),
        );
        expect(textOf(model).length).toBeLessThan(exact.length);
        const codemode = await environment.call({
          operationId: crypto.randomUUID(),
          catalogDigest,
          identity,
          arguments: {},
          caller: { kind: "codemode", subjectId: "codemode:test" },
        });
        expect(codemode.content).toEqual([{ type: "text", text: exact }]);
      }
    } finally {
      await prepared.close();
    }
  });
});

describe("measured reduction", () => {
  test("staging-shaped fixtures shrink", () => {
    const ratio = (identity: AttemptToolIdentity, value: unknown): number => {
      const result = apiResult(value);
      return (
        textOf(projectFirstPartyToolResultSizeForModel(identity, result)).length /
        textOf(result).length
      );
    };
    // Staging (18,790 variables): 27.0% of the original; debug pages: about 68%.
    expect(ratio(VARIABLE_SETS, variableSetListFixture())).toBeLessThan(0.35);
    expect(ratio(EVENTS, debugPageFixture())).toBeLessThan(0.8);
  });
});
