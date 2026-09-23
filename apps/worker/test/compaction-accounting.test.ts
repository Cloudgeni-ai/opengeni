import { expect, spyOn, test } from "bun:test";
import { Agent, Runner, RunRawModelStreamEvent, tool } from "@openai/agents";
import * as db from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { CompactionNeededError, contextRobustnessFilterForSettings } from "@opengeni/runtime";
import { ScriptedModel, assistantMessage, functionCall, testSettings } from "@opengeni/testing";
import {
  createModelResponseEventState,
  modelResponseContextSignal,
  processModelResponseTerminalEvent,
} from "../src/activities/agent-turn/model-usage";

test.each(["delayed", "fresh-large"] as const)(
  "SDK post-compaction stream binds only its own usage: %s",
  async (delivery) => {
    const settings = testSettings({
      contextWindowTokens: 20_000,
      contextAutoCompactThresholdTokens: 10_000,
    });
    const observability = createObservability(settings, { component: "worker" });
    const usageSpy = spyOn(db, "recordUsageEvent").mockImplementation(async () => undefined);
    const factSpy = spyOn(db, "recordModelCallFact").mockImplementation(async () => undefined);
    try {
      const state = createModelResponseEventState();
      const emittedSourceKeys = new Set<string>();
      const usageSources: string[] = [];
      const process = (event: RunRawModelStreamEvent) =>
        processModelResponseTerminalEvent({
          event,
          state,
          dispatchId: "compaction-accounting",
          settings,
          db: {} as any,
          observability,
          publish: (async (batch: any[]) => ({
            accepted: true,
            events: batch.map((fact) => {
              usageSources.push(fact.payload.sourceKey);
              return { ...fact, id: crypto.randomUUID(), turnAssociation: "current" };
            }),
          })) as any,
          accountId: "account",
          workspaceId: "workspace",
          sessionId: "session",
          turnId: "turn",
          turnAttemptId: "attempt",
          provider: "codex-subscription",
          providerApi: "responses",
          model: "codex/gpt-5.6-sol",
          metricProvider: "codex-subscription",
          externallyBilled: true,
          servingCredentialId: null,
          priorSessionCredentialId: null,
          emittedSourceKeys,
          renewLease: async () => undefined,
          leaseLost: () => false,
          leaseLostMessage: "lease lost",
          setLastInputTokens: async () => undefined,
        });
      const oldResponse = new RunRawModelStreamEvent({
        type: "response_done",
        response: {
          id: "before-compaction",
          output: [],
          usage: { inputTokens: 12_000, outputTokens: 10, totalTokens: 12_010 },
        },
      } as any);
      const originalGuard = contextRobustnessFilterForSettings(settings, {
        throwOnCompactionNeeded: true,
        contextCompactionSignal: () => modelResponseContextSignal(state),
      });
      const originalInput = [{ type: "message", role: "user", content: "original history" }] as any;
      await originalGuard({ modelData: { input: originalInput }, agent: {} as any });
      await process(oldResponse);
      await expect(
        originalGuard({
          modelData: { input: [...originalInput, assistantMessage("continue")] },
          agent: {} as any,
        }),
      ).rejects.toBeInstanceOf(CompactionNeededError);

      // Same boundary as runStreamAttempt: retain usage identity across a new
      // SDK run, but replace history and restart the per-request guard.
      const responseCountBeforeStream = state.responseCount;
      const guard = contextRobustnessFilterForSettings(settings, {
        throwOnCompactionNeeded: true,
        contextCompactionSignal: () => modelResponseContextSignal(state, responseCountBeforeStream),
      });
      const freshUsageConsumed = Promise.withResolvers<void>();
      const model = new ScriptedModel([
        {
          id: "after-compaction-1",
          inputTokens: delivery === "fresh-large" ? 12_000 : 100,
          output: [functionCall("continue_work", {}, "new-call")],
        },
        { id: "after-compaction-2", output: [assistantMessage("done")] },
      ]);
      const agent = new Agent({
        name: "compaction-accounting",
        model,
        tools: [
          tool({
            name: "continue_work",
            description: "Continue the deterministic fixture",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            strict: false,
            execute: async () => {
              if (delivery === "fresh-large") await freshUsageConsumed.promise;
              return "ok";
            },
          }),
        ],
      });
      const runner = new Runner({ tracingDisabled: true });
      const stream = await runner.run(agent, "small replacement checkpoint", {
        stream: true,
        historyOwnership: "external",
        callModelInputFilter: guard,
        maxTurns: 3,
      });
      const delayed: RunRawModelStreamEvent[] = [];
      const consume = async () => {
        for await (const event of stream.toStream()) {
          if (!(event instanceof RunRawModelStreamEvent)) continue;
          if (delivery === "delayed") delayed.push(event);
          else {
            const result = await process(event);
            if (result.status === "processed") freshUsageConsumed.resolve();
          }
        }
        await stream.completed;
      };
      if (delivery === "fresh-large") {
        await expect(consume()).rejects.toBeInstanceOf(CompactionNeededError);
        expect(model.calls).toBe(1);
      } else {
        await consume();
        expect(stream.finalOutput).toBe("done");
        expect(model.calls).toBe(2);
        // Reports delivered after both requests keep their true revisions;
        // they must not get reassigned to whichever request is newest.
        for (const event of delayed) await process(event);
      }
      expect((await process(oldResponse)).status).toBe("duplicate");
      expect(usageSources).toEqual(
        delivery === "fresh-large"
          ? ["before-compaction", "after-compaction-1"]
          : ["before-compaction", "after-compaction-1", "after-compaction-2"],
      );
      expect(state.responseCount).toBe(usageSources.length);
      expect(usageSpy).toHaveBeenCalledTimes(usageSources.length);
    } finally {
      usageSpy.mockRestore();
      factSpy.mockRestore();
    }
  },
);
