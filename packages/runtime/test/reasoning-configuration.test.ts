import { expect, test } from "bun:test";
import OpenAI from "openai";
import { OpenAIResponsesModel } from "@openai/agents";
import {
  reasoningConfigurationItem,
  projectReasoningConfigurations,
  latestReasoningConfiguration,
  supportsReasoningConfiguration,
  normalizeCodexRequestBody,
} from "@opengeni/codex";
import {
  buildRemoteV2ReplacementHistory,
  buildCompactionReplacementHistory,
  sanitizeHistoryItemsForModel,
  latestCompactionReplacementFingerprint,
  compactionReplacementFingerprint,
} from "../src/index";
class ProbeModel extends OpenAIResponsesModel {
  send(request: any) {
    return this._fetchResponse(request, false);
  }
}
const state = {
  version: 1 as const,
  baselineEffort: "low" as const,
  effort: "high" as const,
  turnId: "turn-one",
};
const update = reasoningConfigurationItem(state);
const user = { type: "message", role: "user", content: "Proceed" };

test("the real SDK sends only configuration_update protocol fields", async () => {
  let body: any;
  const client = {
    responses: {
      create: async (request: any) => {
        body = request;
        return {
          id: "resp_test",
          output: [],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        };
      },
    },
  } as unknown as OpenAI;
  await new ProbeModel(client, "gpt-6-astra").send({
    systemInstructions: "stable",
    input: [update, user] as any,
    modelSettings: { reasoning: { effort: state.baselineEffort } },
    tools: [],
    outputType: "text",
    handoffs: [],
    tracing: false,
  });
  body = normalizeCodexRequestBody(body, (model) => model);
  expect(body.reasoning.effort).toBe("low");
  expect(body.input[0]).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
  expect(JSON.stringify(body)).not.toContain("opengeniReasoningConfiguration");
});
test("replay retains the original update position and suppresses updates for unsupported providers", () => {
  const history = [update, user, { type: "message", role: "assistant", content: "OK" }];
  expect(sanitizeHistoryItemsForModel(history)).toEqual(history);
  const wireHistory = projectReasoningConfigurations(history, true);
  expect(wireHistory[0]).toEqual({ type: "unknown", providerData: update.providerData });
  expect(wireHistory.slice(1)).toEqual(history.slice(1));
  expect(projectReasoningConfigurations(history, false)).toEqual(history.slice(1));
  const next = reasoningConfigurationItem({ ...state, effort: "medium", turnId: "turn-two" });
  expect(projectReasoningConfigurations([...history, next, user], true).slice(0, 3)).toEqual(
    wireHistory,
  );
  expect(projectReasoningConfigurations([update, next, user], true)).toEqual([
    { type: "unknown", providerData: next.providerData },
    user,
  ]);
});
test("both explicit compaction strategies restore selected effort and original baseline", () => {
  const history = [update, user];
  const compact = buildRemoteV2ReplacementHistory(history, {
    type: "compaction",
    encrypted_content: "blob",
  });
  expect(compact.at(-2)?.type).toBe("compaction");
  expect(compact.at(-1)).toEqual(update);
  expect(latestReasoningConfiguration(compact)).toEqual(state);
  const portable = buildCompactionReplacementHistory(history, "summary");
  expect(portable.at(-1)).toEqual(update);
  expect(latestCompactionReplacementFingerprint(portable)).toBe(
    compactionReplacementFingerprint(portable),
  );
});

test("SDK run-state serialization preserves projected controls and does not leak private baseline metadata", async () => {
  const { Agent, Runner, RunState, tool } = await import("@openai/agents");
  const { ScriptedModel, functionCall: scriptedFunctionCall } = await import("@opengeni/testing");
  const { z } = await import("zod");
  const agent = new Agent({
    name: "configuration restore",
    model: new ScriptedModel([{ output: [scriptedFunctionCall("confirm", {}, "confirm-call")] }]),
    tools: [
      tool({
        name: "confirm",
        description: "test",
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => "OK",
      }),
    ],
  });
  const wire = projectReasoningConfigurations([update, user], true);
  const result = await new Runner({ tracingDisabled: true }).run(agent, wire as any);
  expect(result.interruptions).toHaveLength(1);
  const resumed = await RunState.fromString(agent, result.state.toString());
  expect(resumed.history[0]).toEqual(wire[0]);
  expect(JSON.stringify(resumed.history)).not.toContain("opengeniReasoningConfiguration");
  expect(
    projectReasoningConfigurations(resumed.history as any, false).some(
      (item) => item.type === "unknown",
    ),
  ).toBe(false);
});

test("configuration updates are restricted to the documented model and effort set", () => {
  expect(supportsReasoningConfiguration("gpt-6-astra", "high")).toBe(true);
  expect(supportsReasoningConfiguration("gpt-5.6-luna", "high")).toBe(false);
  expect(supportsReasoningConfiguration("gpt-6-astra", "none")).toBe(false);
});
