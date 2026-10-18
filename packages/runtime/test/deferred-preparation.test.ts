import { expect, test } from "bun:test";
import type { MCPServer, ModelRequest } from "@openai/agents";
import { ScriptedModel, testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, prepareAgentTools, runAgentStream } from "../src/index";
import { LazyToolRuntime } from "../src/lazy-tool-transport";

async function fixture(connectError?: Error, duringConnect?: () => Promise<void>) {
  const calls = { connect: 0, close: 0, invoke: 0 };
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
      return [
        {
          name: "lookup",
          description: "Look up a fixture",
          inputSchema: { type: "object", properties: {} },
        },
      ];
    },
    async callTool() {
      calls.invoke++;
      return [{ type: "text", text: "found" }];
    },
    async invalidateToolsCache() {},
  };
  const settings = testSettings({
    sandboxBackend: "none",
    lazyToolSearchEnabled: true,
    codexToolSearchEnabled: true,
    mcpServers: [{ id: "fixture", url: "https://fixture.invalid/mcp", cacheToolsList: false }],
  });
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "fixture" }], {
    deferNonEagerUntilToolDemand: true,
    deferredPreparationStart: "provider-dispatch",
    localMcpServers: [{ id: "fixture", server }],
  });
  return { calls, prepared, settings };
}

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
  expect(calls).toEqual({ connect: 0, close: 1, invoke: 0 });
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
  expect(calls).toEqual({ connect: 1, close: 1, invoke: 0 });
});
