import { expect, test } from "bun:test";
import type { MCPServer, ModelRequest } from "@openai/agents";
import { ScriptedModel, functionCall } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import { allAgentCapabilities } from "@opengeni/contracts";
import { buildOpenGeniAgent, prepareAgentTools, runAgentStream } from "../src/index";
import { LazyToolRuntime } from "../src/lazy-tool-transport";

async function fixture(
  connectError?: Error,
  duringConnect?: () => Promise<void>,
  options: {
    eager?: boolean;
    blocking?: boolean;
    firstParty?: boolean;
    empty?: boolean;
    persist?: () => Promise<void>;
  } = {},
) {
  const serverId = options.firstParty ? "opengeni" : "fixture";
  const calls = { connect: 0, close: 0, invoke: 0, persist: 0 };
  const server: MCPServer = {
    name: "fixture",
    cacheToolsList: false,
    async connect() {
      calls.connect++;
      await duringConnect?.();
      if (connectError) throw connectError;
    },
    async close() {
      calls.close++;
    },
    async listTools() {
      if (options.empty) return [];
      return [
        {
          name: "lookup",
          description: "Look up a fixture",
          inputSchema: { type: "object", properties: {} },
        },
      ];
    },
    async callTool() {
      if (options.eager) expect(calls.persist).toBe(1);
      calls.invoke++;
      return [{ type: "text", text: "found" }];
    },
    async invalidateToolsCache() {},
  };
  const settings = testSettings({
    sandboxBackend: "none",
    lazyToolSearchEnabled: true,
    codexToolSearchEnabled: true,
    integrationsAllowPrivateNetworkTargets: true,
    mcpServers: [
      {
        id: serverId,
        url: options.firstParty
          ? "http://127.0.0.1:8000/v1/workspaces/{workspaceId}/mcp"
          : "https://fixture.invalid/mcp",
        cacheToolsList: false,
      },
    ],
  });
  const prepared = await prepareAgentTools(
    settings,
    [{ kind: "mcp", id: serverId, eager: options.eager }],
    {
      deferNonEagerUntilToolDemand: !options.blocking,
      deferredPreparationStart: "provider-dispatch",
      ...(options.firstParty
        ? {
            mcpFetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
              if (init?.method !== "POST") return new Response(null, { status: 405 });
              const request = JSON.parse(String(init.body));
              if (request.id === undefined) return new Response(null, { status: 202 });
              const result =
                request.method === "initialize"
                  ? {
                      protocolVersion: "2025-03-26",
                      capabilities: { tools: {} },
                      serverInfo: { name: "opengeni", version: "1" },
                    }
                  : request.method === "tools/list"
                    ? { tools: await server.listTools() }
                    : {};
              return Response.json({ jsonrpc: "2.0", id: request.id, result });
            },
          }
        : { localMcpServers: [{ id: serverId, server }] }),
      ...(options.firstParty ? { firstPartyTools: ["goal_set" as const] } : {}),
      ...(options.eager || options.firstParty
        ? {
            accountId: "11111111-1111-4111-8111-111111111111",
            workspaceId: "22222222-2222-4222-8222-222222222222",
            sessionId: "33333333-3333-4333-8333-333333333333",
            turnId: "44444444-4444-4444-8444-444444444444",
            attemptId: "55555555-5555-4555-8555-555555555555",
            executionGeneration: 1,
            onAttemptToolCatalog: async () => {
              calls.persist++;
              await options.persist?.();
            },
          }
        : {}),
    },
  );
  return { calls, prepared, settings };
}

test("eager-only servers connect before disclosure but catalog persistence waits for dispatch", async () => {
  const { calls, prepared } = await fixture(undefined, undefined, { eager: true });
  try {
    expect(calls.connect).toBe(1);
    expect((await prepared.mcpServers[0]!.listTools()).map((tool) => tool.name)).toEqual([
      "fixture__lookup",
    ]);
    expect(calls.persist).toBe(0);
    expect(prepared.ready).toBeDefined();
    prepared.startDeferredPreparation!();
    prepared.startDeferredPreparation!();
    const complete = await prepared.ready!;
    expect(calls.persist).toBe(1);
    expect(complete.attemptToolCatalog!.entries.map((entry) => entry.modelName)).toEqual([
      "fixture__lookup",
    ]);
  } finally {
    await prepared.close();
  }
  expect(calls.close).toBe(1);
});

test("closing an eager-only preparation before dispatch closes connected servers without building a catalog", async () => {
  const { calls, prepared } = await fixture(undefined, undefined, { eager: true });
  await prepared.close();
  prepared.startDeferredPreparation!();
  await expect(prepared.ready!).rejects.toThrow("closed before it started");
  expect(calls).toEqual({ connect: 1, close: 1, invoke: 0, persist: 0 });
});

test("an eager-only catalog failure fences tool demand and keeps published servers alive until close", async () => {
  const failure = new Error("catalog persistence failed");
  const { calls, prepared } = await fixture(undefined, undefined, {
    eager: true,
    persist: async () => {
      throw failure;
    },
  });
  const lazy = new LazyToolRuntime(
    "generic_dispatch",
    new Set(["fixture"]),
    prepared.ready!.then(() => undefined),
    undefined,
    undefined,
    undefined,
    false,
    false,
    prepared.startDeferredPreparation,
  );
  expect(calls.persist).toBe(0);
  await expect(lazy.ensurePrepared()).rejects.toBe(failure);
  expect(calls.persist).toBe(1);
  expect(calls.close).toBe(0);
  await expect(prepared.close()).rejects.toBe(failure);
  expect(calls.close).toBe(1);
});

test("closing an eager-only catalog joins persistence already in flight", async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { calls, prepared } = await fixture(undefined, undefined, {
    eager: true,
    persist: async () => {
      started();
      await pending;
    },
  });
  prepared.startDeferredPreparation!();
  await entered;
  let closed = false;
  const close = prepared.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(calls.close).toBe(0);
  release();
  await close;
  expect(calls).toEqual({ connect: 1, close: 1, invoke: 0, persist: 1 });
});

test.each(["generic_dispatch", "openai_native", "codex_native"] as const)(
  "configured empty first-party servers do not disclose an extra router while the catalog waits (%s)",
  async (transport) => {
    const requests: string[] = [];
    for (const blocking of [true, false]) {
      const { prepared, settings } = await fixture(undefined, undefined, {
        firstParty: true,
        empty: true,
        blocking,
      });
      try {
        const model = new ScriptedModel("READY");
        const agent = buildOpenGeniAgent(settings, [], {
          mcpServers: prepared.mcpServers,
          skillCatalog: [],
          agentConfig: {
            version: 1,
            from: "all",
            capabilities: allAgentCapabilities(),
            unavailable: [],
            identity: null,
            renderer: "opengeni",
            source: "request",
          },
          lazyToolTransport: transport,
          ...(prepared.ready
            ? {
                toolPreparationReady: prepared.ready.then(() => undefined),
                startToolPreparation: prepared.startDeferredPreparation!,
              }
            : {}),
        }).clone({ model });
        const stream = await runAgentStream(agent, "Reply READY", settings);
        for await (const _event of stream.toStream()) {
          /* drain */
        }
        await stream.completed;
        const request = model.requests[0]!;
        requests.push(
          JSON.stringify({
            input: request.input,
            instructions: request.systemInstructions,
            tools: request.tools,
          }),
        );
      } finally {
        await prepared.close();
      }
    }
    expect(requests[0]).toBe(requests[1]);
  },
);

test.each([
  ["generic_dispatch", false],
  ["generic_dispatch", true],
  ["openai_native", false],
  ["openai_native", true],
  ["codex_native", false],
  ["codex_native", true],
] as const)(
  "eager tool calls and following request bytes match blocking preparation (%s, configured=%s)",
  async (transport, configured) => {
    const requests: string[] = [];
    for (const blocking of [true, false]) {
      const { prepared, settings, calls } = await fixture(undefined, undefined, {
        eager: true,
        blocking,
      });
      try {
        const model = new ScriptedModel([
          { output: [functionCall("fixture__lookup", {}, "lookup-call")] },
          { outputText: "READY" },
        ]);
        const agent = buildOpenGeniAgent(settings, [], {
          mcpServers: prepared.mcpServers,
          skillCatalog: [],
          ...(configured
            ? {
                agentConfig: {
                  version: 1 as const,
                  from: "all" as const,
                  capabilities: allAgentCapabilities(),
                  unavailable: [],
                  identity: null,
                  renderer: "opengeni" as const,
                  source: "request" as const,
                },
              }
            : {}),
          lazyToolTransport: transport,
          ...(prepared.ready
            ? {
                toolPreparationReady: prepared.ready.then(() => undefined),
                startToolPreparation: prepared.startDeferredPreparation!,
              }
            : {}),
        }).clone({ model });
        const stream = await runAgentStream(agent, "Look up the fixture", settings);
        for await (const _event of stream.toStream()) {
          /* drain */
        }
        await stream.completed;
        expect(calls.invoke).toBe(1);
        expect(calls.persist).toBe(1);
        expect(model.requests).toHaveLength(2);
        requests.push(
          JSON.stringify(
            model.requests.map((request) => ({
              input: request.input,
              instructions: request.systemInstructions,
              tools: request.tools,
            })),
          ),
        );
      } finally {
        await prepared.close();
      }
    }
    expect(requests[0]).toBe(requests[1]);
  },
);

test.each(["generic_dispatch", "openai_native", "codex_native"] as const)(
  "eager-only first-request bytes match blocking preparation (%s)",
  async (transport) => {
    const requests: string[] = [];
    for (const blocking of [true, false]) {
      const { prepared, settings } = await fixture(undefined, undefined, { eager: true, blocking });
      try {
        const model = new ScriptedModel("READY");
        const agent = buildOpenGeniAgent(settings, [], {
          mcpServers: prepared.mcpServers,
          lazyToolTransport: transport,
          ...(prepared.ready
            ? {
                toolPreparationReady: prepared.ready.then(() => undefined),
                startToolPreparation: prepared.startDeferredPreparation!,
              }
            : {}),
        }).clone({ model });
        const stream = await runAgentStream(agent, "Reply READY", settings);
        for await (const _event of stream.toStream()) {
          /* drain */
        }
        await stream.completed;
        const request = model.requests[0]!;
        requests.push(
          JSON.stringify({
            input: request.input,
            instructions: request.systemInstructions,
            tools: request.tools,
          }),
        );
      } finally {
        await prepared.close();
      }
    }
    expect(requests[0]).toBe(requests[1]);
  },
);

test.each(["generic_dispatch", "openai_native", "codex_native"] as const)(
  "first model request bytes do not depend on deferred completion (%s)",
  async (transport) => {
    const requests: string[] = [];
    for (const startBeforeModel of [false, true]) {
      const { prepared, settings } = await fixture();
      try {
        if (startBeforeModel) {
          prepared.startDeferredPreparation!();
          await prepared.ready;
        }
        const model = new ScriptedModel("READY");
        const agent = buildOpenGeniAgent(settings, [], {
          mcpServers: prepared.mcpServers,
          lazyToolTransport: transport,
          toolPreparationReady: prepared.ready!.then(() => undefined),
          startToolPreparation: prepared.startDeferredPreparation!,
        }).clone({ model });
        const stream = await runAgentStream(agent, "Reply READY", settings);
        for await (const _event of stream.toStream()) {
          /* drain the simulated response */
        }
        await stream.completed;
        const request = model.requests[0]!;
        requests.push(
          JSON.stringify({
            input: request.input,
            instructions: request.systemInstructions,
            tools: request.tools,
          }),
        );
      } finally {
        await prepared.close();
      }
    }
    expect(requests[0]).toBe(requests[1]);
  },
);

test("deferred preparation stays idle through first-request tool listing and starts once at dispatch", async () => {
  const { calls, prepared } = await fixture();
  try {
    expect(await prepared.mcpServers[0]!.listTools()).toEqual([]);
    expect(calls.connect).toBe(0);
    prepared.startDeferredPreparation!();
    prepared.startDeferredPreparation!();
    await prepared.ready;
    expect(calls.connect).toBe(1);
    expect((await prepared.mcpServers[0]!.listTools()).map((tool) => tool.name)).toEqual([
      "fixture__lookup",
    ]);
  } finally {
    await prepared.close();
  }
});

test("real deferred invocation can start preparation before dispatch", async () => {
  const { calls, prepared } = await fixture();
  try {
    await prepared.mcpServers[0]!.callTool("fixture__lookup", {});
    expect(calls.connect).toBe(1);
    expect(calls.invoke).toBe(1);
  } finally {
    await prepared.close();
  }
});

test("lazy search joins the same preparation when demand precedes dispatch", async () => {
  const { calls, prepared } = await fixture();
  try {
    const lazy = new LazyToolRuntime(
      "generic_dispatch",
      new Set(["fixture"]),
      prepared.ready!.then(() => undefined),
      undefined,
      undefined,
      undefined,
      false,
      false,
      prepared.startDeferredPreparation,
    );
    await lazy.ensurePrepared();
    expect(calls.connect).toBe(1);
    prepared.startDeferredPreparation!();
    expect(calls.connect).toBe(1);
  } finally {
    await prepared.close();
  }
});

test("close before dispatch does not start preparation and prevents later starts", async () => {
  const { calls, prepared } = await fixture();
  await prepared.close();
  prepared.startDeferredPreparation!();
  expect(calls).toEqual({ connect: 0, close: 1, invoke: 0, persist: 0 });
  await expect(prepared.ready!).rejects.toThrow("closed before it started");
});

test("failed deferred preparation still crosses the same completion fence", async () => {
  const { calls, prepared } = await fixture(new Error("fixture connect failed"));
  prepared.startDeferredPreparation!();
  await expect(prepared.ready!).rejects.toThrow();
  await prepared.close().catch(() => undefined);
  expect(calls.connect).toBe(1);
});

test.each([false, true])(
  "provider without a dispatch hook starts preparation after its response (streaming=%s)",
  async (streaming) => {
    const { calls, prepared } = await fixture();
    try {
      const lazy = new LazyToolRuntime(
        "generic_dispatch",
        new Set(["fixture"]),
        prepared.ready!.then(() => undefined),
        undefined,
        undefined,
        undefined,
        false,
        false,
        prepared.startDeferredPreparation,
      );
      const model = lazy.wrapModel(new ScriptedModel("READY"));
      const request: ModelRequest = {
        input: [{ type: "message", role: "user", content: "hello" }],
        modelSettings: {},
        tools: [],
        outputType: "text",
        handoffs: [],
        tracing: false,
      };
      expect(calls.connect).toBe(0);
      if (streaming) {
        const stream = model.getStreamedResponse(request)[Symbol.asyncIterator]();
        expect((await stream.next()).value?.type).toBe("response_started");
        expect(calls.connect).toBe(0);
        await stream.next();
        await prepared.ready;
        while (!(await stream.next()).done) {
          /* drain */
        }
      } else {
        await model.getResponse(request);
        await prepared.ready;
      }
      expect(calls.connect).toBe(1);
    } finally {
      await prepared.close();
    }
  },
);

test("closing after start joins in-flight preparation and releases its resources", async () => {
  let release!: () => void;
  let connecting!: () => void;
  const entered = new Promise<void>((resolve) => {
    connecting = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { calls, prepared } = await fixture(undefined, async () => {
    connecting();
    await pending;
  });
  prepared.startDeferredPreparation!();
  await entered;
  let closed = false;
  const close = prepared.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await close;
  expect(calls).toEqual({ connect: 1, close: 1, invoke: 0, persist: 0 });
});
