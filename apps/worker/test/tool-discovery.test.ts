import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { DecisionUsage } from "@opengeni/decisions";
import { createToolSelector } from "@opengeni/runtime";
import { configuredToolDecisionModel } from "../src/activities/agent-turn/tool-discovery";
import { configuredDecisionModel } from "../src/activities/agent-turn/decision-model";

describe("shared deployment decision category", () => {
  test("unset configuration makes no request", () => {
    expect(
      configuredToolDecisionModel({
        settings: testSettings(),
        recordUsage: async () => {},
        onUnavailable: () => {
          throw new Error("not configured");
        },
        fetch: (async () => {
          throw new Error("must not fetch");
        }) as typeof fetch,
      }),
    ).toBeUndefined();
  });
  test("partial explicit configuration cannot borrow a legacy or customer credential", () => {
    let unavailable = 0;
    const settings = testSettings({
      decisionModelProvider: "openrouter",
      decisionModelId: "openai/gpt-6-luna-decisions",
      jevApiKey: "legacy-test-key",
    });
    expect(
      configuredToolDecisionModel({
        settings,
        recordUsage: async () => {},
        onUnavailable: () => {
          unavailable++;
        },
      }),
    ).toBeUndefined();
    expect(unavailable).toBe(1);
    expect(configuredDecisionModel(settings, { allowLegacyCodeSearch: true })).toBeUndefined();
  });
  test("legacy Jev code-search configuration never silently enables paid tool search", () => {
    const settings = testSettings({ jevApiKey: "legacy-test-key" });
    expect(configuredDecisionModel(settings)).toBeUndefined();
    expect(configuredDecisionModel(settings, { allowLegacyCodeSearch: true })?.id).toBe(
      "jev/jev-latest",
    );
  });
  test("uses the typed endpoint, model and usage hook rather than chat completions", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const usage: DecisionUsage[] = [];
    const choose = configuredToolDecisionModel({
      settings: testSettings({
        decisionModelProvider: "openrouter",
        decisionModelId: "openai/gpt-6-luna-decisions",
        decisionModelApiKey: "test-key-configured",
      }),
      fetch: (async (url, init) => {
        expect(String(url)).toBe("https://openrouter.ai/api/alpha/decisions");
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return Response.json({
          id: "decision-response",
          model: "actual-model-version",
          provider: "OpenAI",
          answers: { 0: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 100, output_tokens: 0, cost: 0.00001 },
        });
      }) as typeof fetch,
      recordUsage: async (_id, event) => {
        usage.push(event);
      },
      onUnavailable: () => {
        throw new Error("available");
      },
    })!;
    expect(
      await createToolSelector(choose)({
        query: "read task",
        candidates: [{ name: "tasks__read", description: "Read task", inputFields: ["id"] }],
      }),
    ).toEqual(["tasks__read"]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.model).toBe("openai/gpt-6-luna-decisions");
    expect(bodies[0]!.messages).toBeUndefined();
    expect(bodies[0]!.tools).toBeUndefined();
    expect(usage[0]).toMatchObject({
      model: "actual-model-version",
      provider: "OpenAI",
      inputTokens: 100,
      costSource: "provider-reported",
    });
  });
});
