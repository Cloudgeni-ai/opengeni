import { describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { Agent, Runner, tool } from "@openai/agents";
import {
  RoutingBackendRecoveryRequiredError,
  RoutingMutationOutcomeUnknownError,
  RoutingMutationOutputRejectedError,
  RoutingSandboxSession,
} from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import { TurnHistorySink } from "../src/activities/agent-turn/history-sink";
import { ScriptedModel, assistantMessage, functionCall } from "@opengeni/testing";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import { sandboxRouteTransitionCode } from "../src/activities/agent-turn/errors";

describe("home resolver recovery through real SDK function tools", () => {
  test.each(["pending", "superseded"] as const)(
    "continues a pre-dispatch %s home route without repeating completed peer work",
    async (recovery) => {
      const providerRead = mock(async () => "contents");
      let ready = false;
      let peerMutations = 0;
      const route = new RoutingSandboxSession({
        readPointer: async () => ({ activeSandboxId: null, activeEpoch: 1 }),
        resolveActiveBackend: async () => {
          if (!ready)
            throw new RoutingBackendRecoveryRequiredError("resolve_home_backend", 1, recovery);
          return { kind: "modal", sandboxId: null, session: { readFile: providerRead } };
        },
      });
      const read = tool({
        name: "read_file",
        description: "Read the current sandbox file.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        strict: false,
        errorFunction: null,
        execute: async () => route.readFile({ path: "/workspace/file" }),
      });
      const peer = tool({
        name: "peer_mutation",
        description: "Record a completed peer tool operation.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        strict: false,
        execute: async () => {
          peerMutations++;
          return "committed";
        },
      });
      const model = new ScriptedModel([
        { output: [functionCall("peer_mutation", {}, "peer-1")] },
        { output: [functionCall("read_file", {}, "read-1")] },
        { output: [assistantMessage("should not dispatch")] },
      ]);
      const stream = await new Runner().run(
        new Agent({ name: "home-recovery", model, tools: [read, peer] }),
        "Read the file",
        { stream: true, historyOwnership: "external" },
      );
      const completed = stream.completed.catch((error: unknown) => error);
      let failure: unknown;
      try {
        for await (const _event of stream.toStream()) {
          /* drain real SDK */
        }
      } catch (error) {
        failure = error;
      }
      failure ??= await completed;
      expect(model.calls).toBe(2);
      expect(providerRead).not.toHaveBeenCalled();
      expect(peerMutations).toBe(1);
      expect(sandboxRouteTransitionCode(failure)).toBe("home_backend_recovery_pending");
      const durableHistory: unknown[] = [];
      const appendHistory = spyOn(db, "appendSessionHistoryItems").mockImplementation(
        async (_db, args) => {
          durableHistory.push(...args.items.map((row) => row.item));
          return true;
        },
      );
      const historySink = new TurnHistorySink({
        db: {} as never,
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
        getTurnId: () => "turn-1",
        getStream: () => stream as never,
        getModelRunSettings: () => testSettings({ sandboxBackend: "none" }),
        getExecutionGeneration: () => 1,
        media: {
          retainNativeGeneratedImagesFromHistory: async () => undefined,
          retainedScreenshotReceiptsByCallId: new Map(),
          generatedImageReceiptsByProviderItemId: new Map(),
        } as never,
      });
      historySink.seedHistory("Read the file", 0);
      const reconcile = spyOn(historySink, "reconcileConversationTruth");
      const requestRecovery = spyOn(db, "requestSessionTurnRecovery").mockImplementation(
        async () => {
          expect(reconcile).toHaveBeenCalledWith({ requireDurable: true });
          return { action: "recovering", events: [] } as never;
        },
      );
      try {
        const result = await settleTurnFailure({
          error: failure,
          input: {
            accountId: "account-1",
            workspaceId: "workspace-1",
            sessionId: "session-1",
            attemptId: "attempt-1",
          },
          settings: {},
          db: {},
          bus: {},
          observability: {},
          wakeSessionWorkflow: async () => undefined,
          signalCodexCapacityWorkflow: async () => undefined,
          cancellationSignal: undefined,
          sandboxRotationController: new AbortController(),
          noteCancellationRequested: () => undefined,
          codexWorkspaceKey: "workspace-key",
          control: {
            cancellationRequestedAt: null,
            activityStatus: "unknown",
            turnMetricOutcome: null,
            activityError: null,
            acknowledgeQuiescence: false,
          },
          attempt: {
            turnId: "turn-1",
            triggerEventId: "trigger-1",
            executionGeneration: 1,
            providerRecoveryCount: 0,
            modelRequestStarted: true,
            redispatchesAtDispatch: 0,
            triggerType: "user",
          },
          billingState: {},
          eventing: { publish: async () => [], turnStartedPublished: true },
          providerTurn: {},
          leases: {},
          historySink,
          claimedResult: (value: Record<string, unknown>) => value,
          flushRuntimeBatcher: async () => undefined,
          acknowledgeLostAttemptOwnership: () => undefined,
          acknowledgeRecoveryQuiescence: () => undefined,
        } as never);
        expect(result).toEqual({ status: "recovering" });
        expect(requestRecovery.mock.calls[0]?.[2]).toMatchObject({
          sessionId: "session-1",
          turnId: "turn-1",
          attemptId: "attempt-1",
          reason: "sandbox_route_transition",
          detail: { code: "home_backend_recovery_pending", effectiveBoundary: "next_attempt" },
        });
        expect(durableHistory).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "function_call_result", callId: "peer-1" }),
          ]),
        );
        ready = true;
        const resumedModel = new ScriptedModel([
          { output: [functionCall("read_file", {}, "read-2")] },
          { output: [assistantMessage("continued")] },
        ]);
        const resumed = await new Runner().run(
          new Agent({ name: "resumed-home", model: resumedModel, tools: [read, peer] }),
          durableHistory as never,
        );
        expect(resumed.finalOutput).toBe("continued");
        expect(providerRead).toHaveBeenCalledTimes(1);
        expect(peerMutations).toBe(1);
      } finally {
        requestRecovery.mockRestore();
        reconcile.mockRestore();
        appendHistory.mockRestore();
      }
    },
  );
  test("message lookalikes, nonrecoverable dispositions and postdispatch errors stay excluded", () => {
    const errors = [
      new Error("RoutingBackendRecoveryRequiredError resolve_home_backend superseded"),
      new RoutingBackendRecoveryRequiredError("writeFile", 1, "superseded"),
      new RoutingBackendRecoveryRequiredError("resolve_home_backend", 1, "degraded"),
      new RoutingBackendRecoveryRequiredError("resolve_home_backend", 1, "unrecoverable"),
      new RoutingBackendRecoveryRequiredError("resolve_home_backend", -1, "pending"),
      Object.assign(new Error("forged"), {
        name: "RoutingBackendRecoveryRequiredError",
        op: "resolve_home_backend",
        leaseEpoch: 1,
        recovery: "pending",
        retryable: true,
      }),
    ];
    for (const error of errors) expect(sandboxRouteTransitionCode(error)).toBeNull();
  });
  test("unknown peer outcomes, unreadable edges and oversized cause graphs veto recovery", () => {
    const proven = new RoutingBackendRecoveryRequiredError("resolve_home_backend", 1, "pending");
    const unknown = new RoutingMutationOutcomeUnknownError("writeFile", "unknown");
    const rejected = new RoutingMutationOutputRejectedError("writeFile", "holder_fenced");
    for (const terminal of [unknown, rejected]) {
      for (const errors of [
        [proven, terminal],
        [terminal, proven],
      ]) {
        expect(sandboxRouteTransitionCode(new AggregateError(errors))).toBeNull();
      }
    }
    expect(
      sandboxRouteTransitionCode(
        new Error("wrapped", { cause: new AggregateError([proven, unknown]) }),
      ),
    ).toBeNull();
    const oversized = new AggregateError([
      proven,
      ...Array.from({ length: 65 }, () => new Error("peer")),
    ]);
    expect(sandboxRouteTransitionCode(oversized)).toBeNull();
    const unreadable = Object.defineProperty(new Error("wrapped"), "cause", {
      get() {
        throw new Error("getter");
      },
    });
    expect(sandboxRouteTransitionCode(new AggregateError([proven, unreadable]))).toBeNull();
  });
});
