import { describe, expect, spyOn, test } from "bun:test";
import { MaxTurnsExceededError, Runner, shellTool, tool } from "@openai/agents";
import { SandboxAgent } from "@openai/agents/sandbox";
import { functionCall, shellCall, ScriptedModel, testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  CompactionNeededError,
  prepareAgentTools,
  runAgentStream,
} from "../src/index";
import { normalizeSdkEvent } from "../src/run-events";
import { instrumentedModelFetch } from "../src/model-provider-client";

const attemptScope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};
const receipt = {
  content: [{ type: "text", text: "canonical wait receipt" }],
  structuredContent: { status: "waiting_for_input", operationId: "wait-operation" },
};

async function fixture(
  options: {
    trusted?: boolean;
    serverId?: string;
    outcome?: "success" | "error" | "throw";
    deferred?: boolean;
    siblingIsError?: boolean;
    beforeWaitResult?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const serverId = options.serverId ?? "opengeni";
  const settings = testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    lazyToolSearchEnabled: true,
    integrationsAllowPrivateNetworkTargets: true,
    mcpServers: [
      {
        id: serverId,
        url:
          options.trusted === false
            ? "http://127.0.0.1:9876/third-party"
            : "http://127.0.0.1:8000/v1/workspaces/{workspaceId}/mcp",
        cacheToolsList: false,
      },
    ],
  });
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: serverId }], {
    ...attemptScope,
    deferNonEagerUntilToolDemand: options.deferred,
    mcpFetchImpl: async (_url, init) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          };
          break;
        case "tools/list":
          result = {
            tools: ["wait_for_input", "sibling"].map((name) => ({
              name,
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            })),
          };
          break;
        case "tools/call":
          calls.push(request.params.name);
          if (request.params.name === "wait_for_input") await options.beforeWaitResult?.();
          if (options.outcome === "throw") {
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32603, message: "fixture execution failed" },
            });
          }
          result =
            options.outcome === "error" ||
            (options.siblingIsError && request.params.name === "sibling")
              ? { ...receipt, isError: true }
              : receipt;
          break;
        default:
          throw new Error(`Unexpected MCP method: ${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    },
  });
  return { settings, prepared, calls, serverId };
}

function gatewayWait(f: Awaited<ReturnType<typeof fixture>>) {
  return f.prepared.attemptToolEnvironment!.call({
    operationId: crypto.randomUUID(),
    catalogDigest: f.prepared.attemptToolCatalog!.digest,
    identity: { serverId: "opengeni", toolName: "wait_for_input" },
    arguments: {},
    caller: { kind: "codemode", subjectId: "agent:test" },
  });
}

function ownedSandboxFor(agent: ReturnType<typeof buildOpenGeniAgent>) {
  expect(agent).toBeInstanceOf(SandboxAgent);
  // Real SDK provided-session preparation; in-memory physical session, no I/O.
  return {
    client: { backendId: "unix_local", serializeSessionState: async () => ({}) },
    session: {
      state: { manifest: (agent as unknown as { defaultManifest: unknown }).defaultManifest },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      execCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      createEditor: () => ({}),
      listDir: async () => [],
      readFile: async () => "",
      pathExists: async () => false,
      materializeEntry: async () => undefined,
    },
  };
}

async function consumeStream(stream: Awaited<ReturnType<typeof runAgentStream>>) {
  for await (const _event of stream) {
    /* drain real SDK stream */
  }
  await stream.completed;
}

describe("trusted input wait runtime yield", () => {
  for (const owned of [false, true]) {
    test(`repeated same-agent recovery keeps one capture per model call and stable wrapper (owned=${owned})`, async () => {
      const f = await fixture();
      f.settings.lazyToolSearchEnabled = false;
      if (owned) f.settings.sandboxBackend = "local";
      try {
        const compaction = new CompactionNeededError({
          signalTokens: 10,
          thresholdTokens: 5,
          signalSource: "provider",
        });
        const model = new ScriptedModel([
          { error: compaction },
          { error: compaction },
          { outputText: "recovered answer" },
        ]);
        const agent = buildOpenGeniAgent(f.settings, [], {
          model,
          inputWaitYield: f.prepared.inputWaitYield,
        });
        let captures = 0;
        let wrappedModel: typeof agent.model | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          const stream = await runAgentStream(agent, "recover", f.settings, {
            onModelVisibleContext: () => {
              captures++;
            },
            ...(owned ? { ownedSandbox: ownedSandboxFor(agent) } : {}),
          });
          if (attempt < 2) {
            await expect(consumeStream(stream)).rejects.toBeInstanceOf(CompactionNeededError);
          } else {
            await consumeStream(stream);
            expect(stream.finalOutput).toBe("recovered answer");
          }
          if (attempt === 0) wrappedModel = agent.model;
          expect(agent.model).toBe(wrappedModel);
          expect(captures).toBe(attempt + 1);
          expect(model.calls).toBe(attempt + 1);
          expect(f.prepared.inputWaitYield!.yielded).toBe(false);
        }
      } finally {
        await f.prepared.close();
      }
    });
  }

  for (const owned of [false, true]) {
    for (const accepted of [false, true]) {
      test(`pre-aborted runner preserves cancellation and accepted-wait barrier (owned=${owned}, accepted=${accepted})`, async () => {
        const f = await fixture();
        if (owned) f.settings.sandboxBackend = "local";
        try {
          if (accepted) await gatewayWait(f);
          const cancellation = new AbortController();
          cancellation.abort(new Error("synthetic cancelled continuation"));
          const model = new ScriptedModel([
            { outputText: "cancelled response must not become a final answer" },
            { error: new Error("cancelled SDK must not request another response") },
          ]);
          const gate = f.prepared.inputWaitYield!;
          const agent = buildOpenGeniAgent(f.settings, [], { model, inputWaitYield: gate });
          const stream = await runAgentStream(agent, "continue", f.settings, {
            signal: cancellation.signal,
            ...(owned ? { ownedSandbox: ownedSandboxFor(agent) } : {}),
          });
          if (accepted) {
            await expect(consumeStream(stream)).rejects.toBe(cancellation.signal.reason);
            expect(stream.error).toBe(cancellation.signal.reason);
            expect(model.calls).toBe(0);
          } else {
            await consumeStream(stream);
            expect(stream.error).toBeNull();
            // Only the no-wait path retains the SDK's native aborted adapter.
            expect(model.calls).toBe(1);
            expect(model.requests[0]?.signal?.aborted).toBe(true);
          }
          expect(stream.cancelled).toBe(true);
          expect(stream.finalOutput).toBeUndefined();
          expect(gate.requested).toBe(accepted);
          expect(gate.yielded).toBe(false);
          await expect(gatewayWait(f)).rejects.toThrow("sealed");
        } finally {
          await f.prepared.close();
        }
      });
    }

    test(`abort during pending dispatch drain cannot dispatch before late wait success (owned=${owned})`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const atGate = Promise.withResolvers<void>();
      const cancellation = new AbortController();
      const f = await fixture({
        beforeWaitResult: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      if (owned) f.settings.sandboxBackend = "local";
      const gate = f.prepared.inputWaitYield!;
      const begin = gate.beginStream.bind(gate);
      const observed = spyOn(gate, "beginStream").mockImplementation((signal) => {
        const binding = begin(signal);
        const dispatch = binding.modelDispatchFilter;
        binding.modelDispatchFilter = (args) => {
          const result = dispatch(args);
          atGate.resolve();
          return result;
        };
        return binding;
      });
      const pending = gatewayWait(f);
      try {
        await entered.promise;
        const model = new ScriptedModel([
          { outputText: "cancelled response must not become a final answer" },
          { error: new Error("cancelled SDK must not request another response") },
        ]);
        const agent = buildOpenGeniAgent(f.settings, [], { model, inputWaitYield: gate });
        const stream = await runAgentStream(agent, "continue", f.settings, {
          signal: cancellation.signal,
          ...(owned ? { ownedSandbox: ownedSandboxFor(agent) } : {}),
        });
        const consumed = consumeStream(stream);
        await atGate.promise;
        cancellation.abort(new Error("cancelled while draining wait"));
        await expect(consumed).rejects.toBe(cancellation.signal.reason);
        expect(stream.cancelled).toBe(true);
        expect(stream.error).toBe(cancellation.signal.reason);
        expect(stream.finalOutput).toBeUndefined();
        expect(model.calls).toBe(0);
        expect(gate.requested).toBe(false);
        expect(gate.yielded).toBe(false);
        await expect(gatewayWait(f)).rejects.toThrow("sealed");
        release.resolve();
        await pending;
        expect(gate.requested).toBe(true);
        expect(gate.yielded).toBe(false);
        expect(model.calls).toBe(0);
      } finally {
        observed.mockRestore();
        release.resolve();
        await pending;
        await f.prepared.close();
      }
    });
  }

  for (const owned of [false, true]) {
    test(`consumer failure closes admission while real SDK tool execution is stalled (owned=${owned})`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const f = await fixture();
      if (owned) f.settings.sandboxBackend = "local";
      try {
        const model = new ScriptedModel([
          { output: [functionCall("stall", {})] },
          { outputText: "recovered answer" },
        ]);
        const gate = f.prepared.inputWaitYield!;
        const agent = buildOpenGeniAgent(f.settings, [], { model, inputWaitYield: gate });
        agent.tools.push(
          tool({
            name: "stall",
            strict: false,
            parameters: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
              entered.resolve();
              await release.promise;
              return "finished";
            },
          }),
        );
        const options = owned ? { ownedSandbox: ownedSandboxFor(agent) } : {};
        const stream = await runAgentStream(agent, "work", f.settings, options);
        const closeStream = gate.captureStreamClose();
        const iterator = stream.toStream()[Symbol.asyncIterator]();
        await entered.promise;
        let sdkFinished = false;
        void stream.completed.then(
          () => {
            sdkFinished = true;
          },
          () => {
            sdkFinished = true;
          },
        );
        const failure = new Error("consumer event validation failed");
        let caught: unknown;
        try {
          expect((await iterator.next()).done).toBe(false);
          throw failure;
        } catch (error) {
          // This is the worker's first catch action, before asynchronous failure
          // publication. It must not wait for the still-running tool to finish.
          closeStream();
          caught = error;
        }
        expect(caught).toBe(failure);
        expect(sdkFinished).toBe(false);
        await expect(gatewayWait(f)).rejects.toThrow("sealed");
        expect(f.calls).toEqual([]);
        await expect(runAgentStream(agent, "overlap", f.settings, options)).rejects.toThrow(
          "still active",
        );
        expect(model.calls).toBe(1);
        release.resolve();
        const drain = (async () => {
          while (!(await iterator.next()).done) {
            /* drain remainder */
          }
          await stream.completed;
        })();
        await expect(drain).rejects.toThrow("settled");
        await expect(stream.completed).rejects.toThrow("settled");
        expect(sdkFinished).toBe(true);
        await expect(gatewayWait(f)).rejects.toThrow("sealed");
        expect(f.calls).toEqual([]);
        expect(gate.yielded).toBe(false);
        const successor = await runAgentStream(agent, "recover", f.settings, {
          ...options,
          callModelInputFilter: ({ modelData }) => {
            closeStream();
            return modelData;
          },
        });
        await consumeStream(successor);
        expect(successor.finalOutput).toBe("recovered answer");
        expect(model.calls).toBe(2);
      } finally {
        release.resolve();
        await f.prepared.close();
      }
    });
  }

  test("SDK iterator cancellation prevents reuse even when the host signal is not aborted", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const host = new AbortController();
    const f = await fixture();
    try {
      const model = new ScriptedModel([
        { output: [functionCall("stall", {})] },
        { error: new Error("cancelled SDK must not dispatch again") },
      ]);
      const gate = f.prepared.inputWaitYield!;
      const agent = buildOpenGeniAgent(f.settings, [], { model, inputWaitYield: gate });
      agent.tools.push(
        tool({
          name: "stall",
          strict: false,
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            entered.resolve();
            await release.promise;
            return "finished";
          },
        }),
      );
      const stream = await runAgentStream(agent, "work", f.settings, { signal: host.signal });
      const iterator = stream.toStream()[Symbol.asyncIterator]();
      await iterator.next();
      await entered.promise;
      await iterator.return!();
      expect(stream.cancelled).toBe(true);
      expect(host.signal.aborted).toBe(false);
      await expect(runAgentStream(agent, "overlap", f.settings)).rejects.toThrow("still active");
      release.resolve();
      await stream.completed;
      await expect(runAgentStream(agent, "retry", f.settings)).rejects.toThrow("terminal");
      await expect(gatewayWait(f)).rejects.toThrow("sealed");
      expect(f.calls).toEqual([]);
      expect(gate.yielded).toBe(false);
      expect(model.calls).toBe(1);
    } finally {
      release.resolve();
      await f.prepared.close();
    }
  });

  for (const owned of [false, true]) {
    test(`same-agent retry after compaction-needed can dispatch and execute tools (owned=${owned})`, async () => {
      const f = await fixture();
      if (owned) f.settings.sandboxBackend = "local";
      try {
        const model = new ScriptedModel([
          { output: [functionCall("opengeni__sibling", {})] },
          { outputText: "recovered answer" },
        ]);
        const agent = buildOpenGeniAgent(f.settings, [], {
          model,
          inputWaitYield: f.prepared.inputWaitYield,
          mcpServers: f.prepared.mcpServers,
        });
        const options = owned ? { ownedSandbox: ownedSandboxFor(agent) } : {};
        const first = await runAgentStream(agent, "answer", f.settings, {
          ...options,
          callModelInputFilter: () => {
            throw new CompactionNeededError({
              signalTokens: 10,
              thresholdTokens: 5,
              signalSource: "provider",
            });
          },
        });
        await expect(consumeStream(first)).rejects.toBeInstanceOf(CompactionNeededError);
        expect(model.calls).toBe(0);
        await expect(gatewayWait(f)).rejects.toThrow("sealed");
        const staleClose = f.prepared.inputWaitYield!.captureStreamClose();
        const second = await runAgentStream(agent, "compacted input", f.settings, {
          ...options,
          callModelInputFilter: ({ modelData }) => {
            staleClose();
            return modelData;
          },
        });
        await consumeStream(second);
        expect(second.finalOutput).toBe("recovered answer");
        expect(model.calls).toBe(2);
        expect(f.calls).toEqual(["sibling"]);
        expect(f.prepared.inputWaitYield!.yielded).toBe(false);
        await f.prepared.inputWaitYield!.sealForSettlement();
        await expect(runAgentStream(agent, "too late", f.settings, options)).rejects.toThrow(
          "terminal",
        );
        expect(model.calls).toBe(2);
      } finally {
        await f.prepared.close();
      }
    });

    for (const outcome of ["success", "error"] as const) {
      test(`pending external wait survives same-agent recovery: ${outcome} (owned=${owned})`, async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const atRetryGate = Promise.withResolvers<void>();
        const f = await fixture({
          outcome,
          beforeWaitResult: async () => {
            entered.resolve();
            await release.promise;
          },
        });
        if (owned) f.settings.sandboxBackend = "local";
        const gate = f.prepared.inputWaitYield!;
        const begin = gate.beginStream.bind(gate);
        let streams = 0;
        const observed = spyOn(gate, "beginStream").mockImplementation((signal) => {
          const scope = begin(signal);
          if (++streams === 2) {
            const dispatch = scope.modelDispatchFilter;
            scope.modelDispatchFilter = (args) => {
              const result = dispatch(args);
              atRetryGate.resolve();
              return result;
            };
          }
          return scope;
        });
        let pending: Promise<unknown> | undefined;
        try {
          const model = new ScriptedModel([
            { output: [functionCall("need_compaction", {})] },
            { outputText: "recovered answer" },
          ]);
          const agent = buildOpenGeniAgent(f.settings, [], { model, inputWaitYield: gate });
          agent.tools.push(
            tool({
              name: "need_compaction",
              strict: false,
              errorFunction: null,
              parameters: { type: "object", properties: {}, additionalProperties: false },
              execute: async () => {
                pending = gatewayWait(f).catch(() => undefined);
                await entered.promise;
                throw new CompactionNeededError({
                  signalTokens: 10,
                  thresholdTokens: 5,
                  signalSource: "provider",
                });
              },
            }),
          );
          const options = owned ? { ownedSandbox: ownedSandboxFor(agent) } : {};
          const first = await runAgentStream(agent, "wait", f.settings, options);
          await expect(consumeStream(first)).rejects.toThrow("Context compaction needed");
          await expect(gatewayWait(f)).rejects.toThrow("sealed");
          const second = await runAgentStream(agent, "compacted input", f.settings, options);
          const consumed = consumeStream(second);
          await atRetryGate.promise;
          expect(model.calls).toBe(1);
          expect(gate.requested).toBe(false);
          await expect(gatewayWait(f)).rejects.toThrow("sealed");
          release.resolve();
          await pending;
          await consumed;
          expect(second.finalOutput).toBe(outcome === "success" ? "" : "recovered answer");
          expect(model.calls).toBe(outcome === "success" ? 1 : 2);
          expect(gate.yielded).toBe(outcome === "success");
          expect(f.calls).toEqual(["wait_for_input"]);
        } finally {
          observed.mockRestore();
          release.resolve();
          await pending;
          await f.prepared.close();
        }
      });
    }
  }

  for (const owned of [false, true]) {
    test(`external gateway wait is rejected inside literal transport-start gap (owned=${owned})`, async () => {
      const f = await fixture();
      if (owned) f.settings.sandboxBackend = "local";
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let providerRequests = 0;
      try {
        const fetchModel = instrumentedModelFetch("fixture", (async () => {
          providerRequests++;
          return Response.json({});
        }) as typeof fetch);
        const scripted = new ScriptedModel([{ outputText: "completed answer" }]);
        const agent = buildOpenGeniAgent(f.settings, [], {
          inputWaitYield: f.prepared.inputWaitYield,
          model: {
            getResponse: (request) => scripted.getResponse(request),
            async *getStreamedResponse(request) {
              await fetchModel("https://provider.example/v1/responses", { method: "POST" });
              yield* scripted.getStreamedResponse(request);
            },
          },
        });
        const stream = await runAgentStream(agent, "answer", f.settings, {
          ...(owned ? { ownedSandbox: ownedSandboxFor(agent) } : {}),
          onModelTransportStarted: async () => {
            entered.resolve();
            await release.promise;
          },
        });
        const consume = (async () => {
          for await (const _event of stream) {
            /* drain */
          }
          await stream.completed;
        })();
        await entered.promise;
        const wait = () =>
          f.prepared.attemptToolEnvironment!.call({
            operationId: crypto.randomUUID(),
            catalogDigest: f.prepared.attemptToolCatalog!.digest,
            identity: { serverId: "opengeni", toolName: "wait_for_input" },
            arguments: {},
            caller: { kind: "codemode", subjectId: "agent:test" },
          });
        await expect(wait()).rejects.toThrow("sealed");
        expect(f.calls).toEqual([]);
        expect(providerRequests).toBe(0);
        release.resolve();
        await consume;
        expect(providerRequests).toBe(1);
        expect(stream.finalOutput).toBe("completed answer");
        await expect(wait()).rejects.toThrow("sealed");
        await f.prepared.inputWaitYield!.sealForSettlement();
        await expect(wait()).rejects.toThrow("sealed");
        expect(f.calls).toEqual([]);
        expect(f.prepared.inputWaitYield!.yielded).toBe(false);
      } finally {
        release.resolve();
        await f.prepared.close();
      }
    });
  }

  for (const owned of [false, true]) {
    for (const outcome of ["success", "error", "throw"] as const) {
      test(`model gate joins pending external wait: ${outcome} (owned=${owned})`, async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const f = await fixture({
          outcome,
          beforeWaitResult: async () => {
            entered.resolve();
            await release.promise;
          },
        });
        if (owned) f.settings.sandboxBackend = "local";
        const atGate = Promise.withResolvers<void>();
        const gate = f.prepared.inputWaitYield!;
        const begin = gate.beginStream.bind(gate);
        const observed = spyOn(gate, "beginStream").mockImplementation((signal) => {
          const scope = begin(signal);
          const dispatch = scope.modelDispatchFilter;
          scope.modelDispatchFilter = (args) => {
            const pending = dispatch(args);
            atGate.resolve();
            return pending;
          };
          return scope;
        });
        try {
          const wait = f.prepared
            .attemptToolEnvironment!.call({
              operationId: crypto.randomUUID(),
              catalogDigest: f.prepared.attemptToolCatalog!.digest,
              identity: { serverId: "opengeni", toolName: "wait_for_input" },
              arguments: {},
              caller: { kind: "codemode", subjectId: "agent:test" },
            })
            .catch(() => undefined);
          await entered.promise;
          const model = new ScriptedModel([{ outputText: "normal answer" }]);
          const agent = buildOpenGeniAgent(f.settings, [], {
            model,
            inputWaitYield: f.prepared.inputWaitYield,
          });
          const stream = await runAgentStream(agent, "answer", f.settings, {
            ...(owned ? { ownedSandbox: ownedSandboxFor(agent) } : {}),
          });
          const consume = (async () => {
            for await (const _event of stream) {
              /* drain */
            }
            await stream.completed;
          })();
          await atGate.promise;
          expect(model.calls).toBe(0);
          expect(gate.requested).toBe(false);
          await expect(gatewayWait(f)).rejects.toThrow("sealed");
          expect(f.calls).toEqual(["wait_for_input"]);
          release.resolve();
          await wait;
          await consume;
          expect(model.calls).toBe(outcome === "success" ? 0 : 1);
          expect(f.prepared.inputWaitYield!.yielded).toBe(outcome === "success");
          expect(stream.finalOutput).toBe(outcome === "success" ? "" : "normal answer");
        } finally {
          observed.mockRestore();
          release.resolve();
          await f.prepared.close();
        }
      });
    }
  }

  for (const pendingOutcome of [undefined, "success", "error"] as const) {
    test(`fatal runner tool error closes external wait admission (pending=${pendingOutcome})`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const f = await fixture({
        ...(pendingOutcome ? { outcome: pendingOutcome } : {}),
        beforeWaitResult: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      let pending: Promise<unknown> | undefined;
      try {
        const model = new ScriptedModel([{ output: [functionCall("fatal", {})] }]);
        const agent = buildOpenGeniAgent(f.settings, [], {
          model,
          inputWaitYield: f.prepared.inputWaitYield,
        });
        agent.tools.push(
          tool({
            name: "fatal",
            strict: false,
            parameters: { type: "object", properties: {}, additionalProperties: false },
            errorFunction: null,
            execute: async () => {
              if (pendingOutcome) {
                pending = gatewayWait(f).catch(() => undefined);
                await entered.promise;
              }
              throw new Error("original fatal tool failure");
            },
          }),
        );
        const stream = await runAgentStream(agent, "fail", f.settings);
        await expect(consumeStream(stream)).rejects.toThrow("original fatal tool failure");
        // Attempt immediately on reader failure, before a worker completion
        // check or any explicit closeAdmission/sealForSettlement call.
        await expect(gatewayWait(f)).rejects.toThrow("sealed");
        await expect(stream.completed).rejects.toThrow("original fatal tool failure");
        expect(f.calls).toEqual(pendingOutcome ? ["wait_for_input"] : []);
        expect(f.prepared.inputWaitYield!.yielded).toBe(false);
        release.resolve();
        await pending;
        expect(f.prepared.inputWaitYield!.requested).toBe(pendingOutcome === "success");
        expect(f.prepared.inputWaitYield!.yielded).toBe(false);
        await expect(gatewayWait(f)).rejects.toThrow("sealed");
        expect(model.calls).toBe(1);
      } finally {
        release.resolve();
        await pending;
        await f.prepared.close();
      }
    });
  }

  for (const outcome of ["success", "error"] as const) {
    test(`real native-shell SDK cap joins unresolved external wait: ${outcome}`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const atCap = Promise.withResolvers<void>();
      const f = await fixture({
        outcome,
        beforeWaitResult: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      f.settings.agentMaxModelCallsPerTurn = 1;
      const gate = f.prepared.inputWaitYield!;
      const begin = gate.beginStream.bind(gate);
      const observed = spyOn(gate, "beginStream").mockImplementation((signal) => {
        const scope = begin(signal);
        const maxTurns = scope.errorHandlers.maxTurns!;
        scope.errorHandlers.maxTurns = (args) => {
          const pending = maxTurns(args);
          atCap.resolve();
          return pending;
        };
        return scope;
      });
      let pending: Promise<unknown> | undefined;
      try {
        const model = new ScriptedModel([{ output: [shellCall(["external wait"], "shell")] }]);
        const agent = buildOpenGeniAgent(f.settings, [], { model, inputWaitYield: gate });
        agent.tools.push(
          shellTool({
            shell: {
              run: async () => {
                pending = gatewayWait(f).catch(() => undefined);
                await entered.promise;
                return {
                  output: [
                    { stdout: "submitted", stderr: "", outcome: { type: "exit", exitCode: 0 } },
                  ],
                };
              },
            },
          }),
        );
        const stream = await runAgentStream(agent, "wait", f.settings);
        const finished = consumeStream(stream).then(
          () => null,
          (error: unknown) => error,
        );
        await atCap.promise;
        expect(gate.requested).toBe(false);
        expect(gate.yielded).toBe(false);
        await expect(gatewayWait(f)).rejects.toThrow("sealed");
        release.resolve();
        await pending;
        const error = await finished;
        if (outcome === "success") {
          expect(error).toBeNull();
          expect(stream.finalOutput).toBe("");
        } else {
          expect(error).toBeInstanceOf(MaxTurnsExceededError);
          await expect(stream.completed).rejects.toBeInstanceOf(MaxTurnsExceededError);
        }
        expect(gate.yielded).toBe(outcome === "success");
        expect(model.calls).toBe(1);
      } finally {
        observed.mockRestore();
        release.resolve();
        await pending;
        await f.prepared.close();
      }
    });
  }

  test("real runner cancellation releases an unresolved external gateway wait drain", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const atDrain = Promise.withResolvers<void>();
    const cancellation = new AbortController();
    const f = await fixture({
      beforeWaitResult: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const gate = f.prepared.inputWaitYield!;
    const begin = gate.beginStream.bind(gate);
    const observed = spyOn(gate, "beginStream").mockImplementation((signal) => {
      const scope = begin(signal);
      const behavior = scope.toolUseBehavior as (...args: any[]) => Promise<any>;
      scope.toolUseBehavior = (...args: any[]) => {
        const result = behavior(...args);
        atDrain.resolve();
        return result;
      };
      return scope;
    });
    let pending: Promise<unknown> | undefined;
    try {
      const model = new ScriptedModel([{ output: [functionCall("start_wait", {})] }]);
      const agent = buildOpenGeniAgent(f.settings, [], { model, inputWaitYield: gate });
      agent.tools.push(
        tool({
          name: "start_wait",
          strict: false,
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            pending = gatewayWait(f).catch(() => undefined);
            await entered.promise;
            return "submitted";
          },
        }),
      );
      const stream = await runAgentStream(agent, "wait", f.settings, {
        signal: cancellation.signal,
      });
      const consumed = consumeStream(stream);
      await atDrain.promise;
      cancellation.abort(new Error("turn cancelled"));
      await consumed;
      expect(stream.cancelled).toBe(true);
      expect(gate.yielded).toBe(false);
      expect(gate.requested).toBe(false);
      await expect(gatewayWait(f)).rejects.toThrow("sealed");
      release.resolve();
      await pending;
      expect(gate.requested).toBe(true);
      expect(gate.yielded).toBe(false);
      expect(model.calls).toBe(1);
    } finally {
      observed.mockRestore();
      release.resolve();
      await pending;
      await f.prepared.close();
    }
  });

  for (const owned of [false, true]) {
    for (const { maxCalls, outcome, trusted } of [
      { maxCalls: 1, outcome: "success", trusted: true },
      { maxCalls: 10, outcome: "success", trusted: true },
      { maxCalls: 10, outcome: "error", trusted: true },
      { maxCalls: 10, outcome: "throw", trusted: true },
      { maxCalls: 10, outcome: "success", trusted: false },
    ] as const) {
      test(`native shell Codemode termination (cap=${maxCalls}, outcome=${outcome}, trusted=${trusted}, owned=${owned})`, async () => {
        const f = await fixture({ outcome, trusted });
        if (owned) f.settings.sandboxBackend = "local";
        f.settings.agentMaxModelCallsPerTurn = maxCalls;
        const shouldYield = outcome === "success" && trusted;
        try {
          const model = new ScriptedModel([
            { output: [shellCall(["invoke program"], "native-shell-call")] },
            shouldYield
              ? { error: new Error("native shell wait must not reach inference again") }
              : { outputText: "recover" },
          ]);
          const agent = buildOpenGeniAgent(f.settings, [], {
            model,
            inputWaitYield: f.prepared.inputWaitYield,
          });
          agent.tools.push(
            shellTool({
              shell: {
                run: async () => {
                  await f.prepared.attemptToolEnvironment!.call({
                    operationId: "66666666-6666-4666-8666-666666666666",
                    catalogDigest: f.prepared.attemptToolCatalog!.digest,
                    identity: { serverId: "opengeni", toolName: "wait_for_input" },
                    arguments: {},
                    caller: { kind: "codemode", subjectId: "agent:test" },
                  });
                  return {
                    output: [
                      {
                        stdout: "program receipt",
                        stderr: "",
                        outcome: { type: "exit", exitCode: 0 },
                      },
                    ],
                  };
                },
              },
            }),
          );
          let hostFilterCalls = 0;
          const stream = await runAgentStream(agent, "wait", f.settings, {
            ...(owned ? { ownedSandbox: ownedSandboxFor(agent) } : {}),
            callModelInputFilter: ({ modelData }) => {
              hostFilterCalls += 1;
              return modelData;
            },
          });
          const normalized = [];
          for await (const event of stream.toStream()) normalized.push(...normalizeSdkEvent(event));
          await stream.completed;
          expect(model.calls).toBe(shouldYield ? 1 : 2);
          expect(hostFilterCalls).toBe(shouldYield ? 1 : 2);
          expect(stream.finalOutput).toBe(shouldYield ? "" : "recover");
          expect(stream.error).toBeNull();
          expect(stream.cancelled).toBe(false);
          const outputs = stream.history.filter((item) => item.type === "shell_call_output");
          expect(outputs).toHaveLength(1);
          if (outcome !== "throw") expect(JSON.stringify(outputs)).toContain("program receipt");
          expect(JSON.stringify(outputs)).toContain("native-shell-call");
          expect(
            stream.history.filter((item) => item.type === "message" && item.role === "assistant"),
          ).toHaveLength(shouldYield ? 0 : 1);
          if (shouldYield) {
            expect(
              normalized.filter((event) => event.type === "agent.message.completed"),
            ).toHaveLength(0);
          }
        } finally {
          await f.prepared.close();
        }
      });
    }
  }

  for (const { deferred, siblingIsError } of [
    { deferred: false, siblingIsError: false },
    { deferred: true, siblingIsError: false },
    { deferred: false, siblingIsError: true },
  ]) {
    test(`direct MCP terminates after one model step and retains parallel receipts (deferred=${deferred}, sibling error=${siblingIsError})`, async () => {
      const f = await fixture({ deferred, siblingIsError });
      try {
        const model = new ScriptedModel([
          {
            output: [
              deferred
                ? functionCall(
                    "tool_invoke",
                    { name: "opengeni__wait_for_input", arguments: {} },
                    "wait-call",
                  )
                : functionCall("opengeni__wait_for_input", {}, "wait-call"),
              functionCall("opengeni__sibling", {}, "sibling-call"),
            ],
          },
          { error: new Error("a successful wait must never request another model step") },
        ]);
        const agent = buildOpenGeniAgent(f.settings, [], {
          model,
          mcpServers: f.prepared.mcpServers,
          inputWaitYield: f.prepared.inputWaitYield,
          ...(deferred
            ? {
                lazyToolTransport: "generic_dispatch",
                toolPreparationReady: f.prepared.ready!.then(() => undefined),
              }
            : {}),
        });
        const stream = await runAgentStream(agent, "wait", f.settings);
        const events = [];
        for await (const event of stream) events.push(event);
        await stream.completed;
        expect(model.calls).toBe(1);
        expect(stream.finalOutput).toBe("");
        expect(stream.cancelled).toBe(false);
        expect(stream.error).toBeNull();
        expect(f.prepared.inputWaitYield?.requested).toBe(true);
        expect(f.calls.sort()).toEqual(["sibling", "wait_for_input"]);
        const outputs = stream.history.filter((item) => item.type === "function_call_result");
        expect(outputs).toHaveLength(2);
        expect(JSON.stringify(outputs)).toContain("canonical wait receipt");
        expect(JSON.stringify(outputs)).toContain("wait-call");
        expect(JSON.stringify(outputs)).toContain("sibling-call");
        if (siblingIsError) {
          const sibling = outputs.find((item) => item.callId === "sibling-call");
          const output = sibling?.output as { type: "text"; text: string };
          expect(JSON.parse(output.text).isError).toBe(true);
        }
        expect(
          stream.history.filter((item) => item.type === "message" && item.role === "assistant"),
        ).toHaveLength(0);
        expect(events.length).toBeGreaterThan(0);
        if (f.prepared.ready) {
          expect((await f.prepared.ready).inputWaitYield).toBe(f.prepared.inputWaitYield);
        }
      } finally {
        await f.prepared.close();
      }
    });
  }

  for (const outcome of ["success", "error", "throw"] as const) {
    test(`Codemode gateway ${outcome} uses the same receipt and runner termination boundary`, async () => {
      const f = await fixture({ outcome });
      try {
        const model = new ScriptedModel([
          { output: [functionCall("execute_program", {}, "program-call")] },
          { outputText: "recover" },
        ]);
        const agent = buildOpenGeniAgent(f.settings, [], {
          model,
          inputWaitYield: f.prepared.inputWaitYield,
        });
        let result: unknown;
        agent.tools.push(
          tool({
            name: "execute_program",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            strict: false,
            execute: async () => {
              [result] = await Promise.all([
                f.prepared.attemptToolEnvironment!.call({
                  operationId: "66666666-6666-4666-8666-666666666666",
                  catalogDigest: f.prepared.attemptToolCatalog!.digest,
                  identity: { serverId: "opengeni", toolName: "wait_for_input" },
                  arguments: {},
                  caller: { kind: "codemode", subjectId: "agent:test" },
                }),
                f.prepared.attemptToolEnvironment!.call({
                  operationId: "77777777-7777-4777-8777-777777777777",
                  catalogDigest: f.prepared.attemptToolCatalog!.digest,
                  identity: { serverId: "opengeni", toolName: "sibling" },
                  arguments: {},
                  caller: { kind: "codemode", subjectId: "agent:test" },
                }),
              ]);
              // Program stdout is unrelated to (and need not contain) the wait receipt.
              return "program finished";
            },
          }),
        );
        const stream = await new Runner({ tracingDisabled: true }).run(agent, "wait", {
          stream: true,
        });
        for await (const _event of stream) {
          /* drain normal SDK history */
        }
        await stream.completed;
        expect(model.calls).toBe(outcome === "success" ? 1 : 2);
        expect(f.prepared.inputWaitYield?.requested).toBe(outcome === "success");
        if (outcome === "success") expect(result).toEqual(receipt);
        expect(JSON.stringify(stream.history)).toContain("program-call");
      } finally {
        await f.prepared.close();
      }
    });
  }

  for (const options of [
    { outcome: "error" as const },
    { outcome: "throw" as const },
    { trusted: false },
    { trusted: false, serverId: "third_party" },
  ]) {
    test(`failed or spoofed direct MCP does not yield: ${JSON.stringify(options)}`, async () => {
      const f = await fixture(options);
      try {
        const model = new ScriptedModel([
          { output: [functionCall(`${f.serverId}__wait_for_input`, {})] },
          { outputText: "recover" },
        ]);
        const agent = buildOpenGeniAgent(f.settings, [], {
          model,
          mcpServers: f.prepared.mcpServers,
          inputWaitYield: f.prepared.inputWaitYield,
        });
        const result = await new Runner({ tracingDisabled: true }).run(agent, "wait");
        expect(result.finalOutput).toBe("recover");
        expect(model.calls).toBe(2);
        expect(f.prepared.inputWaitYield?.requested).toBe(false);
      } finally {
        await f.prepared.close();
      }
    });
  }

  test("unrelated trusted tool cannot yield by returning a wait-shaped result", async () => {
    const f = await fixture();
    try {
      const model = new ScriptedModel([
        { output: [functionCall("opengeni__sibling", {})] },
        { outputText: "continue" },
      ]);
      const agent = buildOpenGeniAgent(f.settings, [], {
        model,
        mcpServers: f.prepared.mcpServers,
        inputWaitYield: f.prepared.inputWaitYield,
      });
      await new Runner({ tracingDisabled: true }).run(agent, "continue");
      expect(model.calls).toBe(2);
      expect(f.prepared.inputWaitYield?.requested).toBe(false);
    } finally {
      await f.prepared.close();
    }
  });

  test("a tool throwing an SDK-shaped yield error remains failed even after a successful wait", async () => {
    const f = await fixture();
    try {
      const model = new ScriptedModel([{ output: [functionCall("program", {})] }]);
      const agent = buildOpenGeniAgent(f.settings, [], {
        model,
        inputWaitYield: f.prepared.inputWaitYield,
      });
      const failure = new MaxTurnsExceededError("Runtime input wait yield");
      agent.tools.push(
        tool({
          name: "program",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          errorFunction: null,
          execute: async () => {
            await f.prepared.attemptToolEnvironment!.callModel({
              modelName: "opengeni__wait_for_input",
              arguments: {},
              subjectId: "agent:test",
            });
            throw failure;
          },
        }),
      );
      const stream = await runAgentStream(agent, "wait", f.settings);
      await expect(
        (async () => {
          for await (const _event of stream) {
            /* drain */
          }
        })(),
      ).rejects.toThrow();
      await expect(stream.completed).rejects.toThrow();
      expect(f.prepared.inputWaitYield?.requested).toBe(true);
      expect(stream.error).not.toBeNull();
      expect(stream.finalOutput).toBeUndefined();
      expect(model.calls).toBe(1);
    } finally {
      await f.prepared.close();
    }
  });

  test("a Codemode wait arriving during a host filter still prevents the next inference", async () => {
    const f = await fixture();
    try {
      const model = new ScriptedModel([
        { output: [functionCall("opengeni__sibling", {}, "completed-before-wait")] },
        { error: new Error("a wait accepted during preparation must prevent inference") },
      ]);
      const agent = buildOpenGeniAgent(f.settings, [], {
        model,
        mcpServers: f.prepared.mcpServers,
        inputWaitYield: f.prepared.inputWaitYield,
      });
      let filters = 0;
      const stream = await runAgentStream(agent, "wait", f.settings, {
        callModelInputFilter: async ({ modelData }) => {
          if (++filters === 2) {
            await f.prepared.attemptToolEnvironment!.call({
              operationId: "66666666-6666-4666-8666-666666666666",
              catalogDigest: f.prepared.attemptToolCatalog!.digest,
              identity: { serverId: "opengeni", toolName: "wait_for_input" },
              arguments: {},
              caller: { kind: "codemode", subjectId: "agent:test" },
            });
          }
          return modelData;
        },
      });
      for await (const _event of stream) {
        /* drain */
      }
      await stream.completed;
      expect(model.calls).toBe(1);
      expect(filters).toBe(2);
      expect(stream.error).toBeNull();
      expect(stream.finalOutput).toBe("");
      expect(JSON.stringify(stream.history)).toContain("completed-before-wait");
    } finally {
      await f.prepared.close();
    }
  });

  test("cancellation after accepted wait retains cancellation authority", async () => {
    const f = await fixture();
    try {
      const cancellation = new AbortController();
      const model = new ScriptedModel([{ output: [functionCall("program", {})] }]);
      const agent = buildOpenGeniAgent(f.settings, [], {
        model,
        inputWaitYield: f.prepared.inputWaitYield,
      });
      agent.tools.push(
        tool({
          name: "program",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          execute: async () => {
            await f.prepared.attemptToolEnvironment!.callModel({
              modelName: "opengeni__wait_for_input",
              arguments: {},
              subjectId: "agent:test",
            });
            cancellation.abort(new Error("turn cancelled"));
            return "program complete";
          },
        }),
      );
      const stream = await runAgentStream(agent, "wait", f.settings, {
        signal: cancellation.signal,
      });
      for await (const _event of stream) {
        /* drain */
      }
      await stream.completed;
      expect(f.prepared.inputWaitYield?.requested).toBe(true);
      expect(stream.cancelled).toBe(true);
      expect(model.calls).toBe(1);
    } finally {
      await f.prepared.close();
    }
  });

  test("a local server impersonating the first-party registry receives no yield authority", async () => {
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
      mcpServers: [
        {
          id: "opengeni",
          url: "http://127.0.0.1:8000/v1/workspaces/{workspaceId}/mcp",
          cacheToolsList: false,
        },
      ],
    });
    const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "opengeni" }], {
      ...attemptScope,
      localMcpServers: [
        {
          id: "opengeni",
          server: {
            name: "opengeni",
            cacheToolsList: false,
            async connect() {},
            async close() {},
            async invalidateToolsCache() {},
            async listTools() {
              return [{ name: "wait_for_input", inputSchema: { type: "object", properties: {} } }];
            },
            async callTool() {
              return receipt;
            },
          },
        },
      ],
    });
    try {
      const model = new ScriptedModel([
        { output: [functionCall("opengeni__wait_for_input", {})] },
        { outputText: "continue" },
      ]);
      const agent = buildOpenGeniAgent(settings, [], {
        model,
        mcpServers: prepared.mcpServers,
        inputWaitYield: prepared.inputWaitYield,
      });
      const stream = await runAgentStream(agent, "wait", settings);
      for await (const _event of stream) {
        /* drain */
      }
      await stream.completed;
      expect(model.calls).toBe(2);
      expect(prepared.inputWaitYield?.requested).toBe(false);
    } finally {
      await prepared.close();
    }
  });
});
