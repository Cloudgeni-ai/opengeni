import { describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { buildAgentCapabilities } from "@opengeni/runtime";
import { resolveSandboxRoute } from "../src/activities/agent-turn/sandbox-establish";
import { Agent, Runner, tool, type ModelRequest, type StreamEvent } from "@openai/agents";
import { ScriptedModel, assistantMessage, functionCall } from "@opengeni/testing";
import { checkpointHistoryBeforeProviderDispatch } from "../src/activities/agent-turn/provider-dispatch-barrier";
import { sandboxRouteTransitionCode } from "../src/activities/agent-turn/errors";

describe("sandboxless attempt attachment boundary", () => {
  test.each(["attached before first turn", "attached during prior attempt"])(
    "binds native capabilities when %s",
    async () => {
      const settings = testSettings({ sandboxBackend: "none", sandboxSelfhostedEnabled: true });
      const pointer = spyOn(db, "readActiveSandbox").mockResolvedValue({
        activeSandboxId: "machine-1",
        activeEpoch: 1,
        activeWorkingDir: null,
      } as never);
      const sandbox = spyOn(db, "getSandbox").mockResolvedValue({
        id: "machine-1",
        kind: "selfhosted",
        enrollmentId: "enrollment-1",
        status: "ready",
      } as never);
      const eventing = { modelRunSettings: settings };
      try {
        const route = await resolveSandboxRoute({
          input: { accountId: "account-1", workspaceId: "workspace-1", sessionId: "session-1" },
          settings,
          db: {},
          eventing,
          media: {},
          sandboxState: {},
          runSettings: settings,
          logicalSandboxSettings: settings,
        } as never);
        expect(route.machinePrimary).toBe(true);
        expect(eventing.modelRunSettings.sandboxBackend).toBe("selfhosted");
        expect(settings.sandboxBackend).toBe("none");
        const capabilities = buildAgentCapabilities(eventing.modelRunSettings, []);
        expect(capabilities.some((capability) => capability.type === "shell")).toBe(true);
      } finally {
        pointer.mockRestore();
        sandbox.mockRestore();
      }
    },
  );
  test("checkpoints a successful attachment and peer mutation before requiring a fresh attempt", async () => {
    let pointer: { activeSandboxId: string | null } = { activeSandboxId: null };
    let stream: { state: { history?: unknown[] } } | undefined;
    let durableHistory: unknown[] = [];
    let attached = 0;
    let mutations = 0;
    let dispatched = 0;
    const historySink = {
      reconcileConversationTruth: mock(async () => {
        durableHistory = [...(stream?.state.history ?? [])];
      }),
    };
    class ObservedModel extends ScriptedModel {
      override async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
        await checkpointHistoryBeforeProviderDispatch(historySink, {
          effectiveSandboxBackend: "none",
          routingEnabled: true,
          readActiveSandbox: async () => pointer,
        });
        dispatched++;
        yield* super.getStreamedResponse(request);
      }
    }
    const attach = tool({
      name: "attach_machine",
      description: "Attach the authorized fixture machine.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: false,
      execute: async () => {
        attached++;
        pointer = { activeSandboxId: "machine-1" };
        return "attached";
      },
    });
    const mutate = tool({
      name: "mutate",
      description: "Record one fixture mutation.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: false,
      execute: async () => {
        mutations++;
        return "committed";
      },
    });
    const agent = new Agent({
      name: "attachment-test",
      model: new ObservedModel([
        {
          output: [
            functionCall("attach_machine", {}, "attach-1"),
            functionCall("mutate", {}, "mutation-1"),
          ],
        },
        { output: [assistantMessage("still no native tools")] },
      ]),
      tools: [attach, mutate],
    });
    const result = await new Runner().run(agent, "attach then work", {
      stream: true,
      historyOwnership: "external",
    });
    stream = result as unknown as typeof stream;
    const completion = result.completed.catch((error: unknown) => error);
    let failure: unknown;
    try {
      for await (const _event of result.toStream()) {
        /* drain SDK events */
      }
    } catch (error) {
      failure = error;
    }
    failure ??= await completion;
    expect(sandboxRouteTransitionCode(failure)).toBe("native_capabilities_changed_this_attempt");
    expect(dispatched).toBe(1);
    expect(attached).toBe(1);
    expect(mutations).toBe(1);
    expect(durableHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call_result", callId: "attach-1" }),
        expect.objectContaining({ type: "function_call_result", callId: "mutation-1" }),
      ]),
    );
    const resumed = new Agent({
      name: "resumed-attachment-test",
      model: new ScriptedModel([
        { output: [assistantMessage("continued from completed tool receipts")] },
      ]),
      tools: [attach, mutate],
    });
    const continued = await new Runner().run(resumed, durableHistory as never);
    expect(continued.finalOutput).toBe("continued from completed tool receipts");
    expect(attached).toBe(1);
    expect(mutations).toBe(1);
  });

  test("does not change ordinary or disabled routes and never masks a history failure", async () => {
    const read = mock(async () => ({ activeSandboxId: "machine-1" }));
    const sink = { reconcileConversationTruth: mock(async () => {}) };
    for (const effectiveSandboxBackend of ["selfhosted", "modal", "docker"] as const) {
      await checkpointHistoryBeforeProviderDispatch(sink, {
        effectiveSandboxBackend,
        routingEnabled: true,
        readActiveSandbox: read,
      });
    }
    await checkpointHistoryBeforeProviderDispatch(sink, {
      effectiveSandboxBackend: "none",
      routingEnabled: false,
      readActiveSandbox: read,
    });
    expect(read).not.toHaveBeenCalled();
    await expect(
      checkpointHistoryBeforeProviderDispatch(sink, {
        effectiveSandboxBackend: "none",
        routingEnabled: true,
        readActiveSandbox: async () => {
          throw new Error("route read unavailable");
        },
      }),
    ).rejects.toThrow("route read unavailable");
    await checkpointHistoryBeforeProviderDispatch(sink, {
      effectiveSandboxBackend: "none",
      routingEnabled: true,
      readActiveSandbox: async () => null,
    });
    await expect(
      checkpointHistoryBeforeProviderDispatch(
        {
          reconcileConversationTruth: async () => {
            throw new Error("history unavailable");
          },
        },
        {
          effectiveSandboxBackend: "none",
          routingEnabled: true,
          readActiveSandbox: read,
        },
      ),
    ).rejects.toThrow("history unavailable");
    expect(read).not.toHaveBeenCalled();
  });
});
