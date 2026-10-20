import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { OpenGeniRuntime } from "@opengeni/runtime";
import { configuredToolDecisionModel } from "../src/activities/agent-turn/tool-discovery";

describe("configured discovery decision provider", () => {
  test("unset configuration makes no provider lookup", () => {
    const model = configuredToolDecisionModel({
      settings: testSettings(),
      runtime: {
        resolveTurnModel: () => {
          throw new Error("must not resolve");
        },
      },
      recordUsage: async () => {},
      onUnavailable: () => {
        throw new Error("not unavailable");
      },
    });
    expect(model).toBeUndefined();
  });
  test("missing routes do not prevent compact discovery", () => {
    let unavailable = 0;
    const model = configuredToolDecisionModel({
      settings: testSettings({ toolSearchDecisionModelId: "test/decision" }),
      runtime: { resolveTurnModel: () => null },
      recordUsage: async () => {},
      onUnavailable: () => {
        unavailable++;
      },
    });
    expect(model).toBeUndefined();
    expect(unavailable).toBe(1);
  });
  test("a customer-owned route is not silently charged for internal inference", () => {
    const route = {
      provider: { credentialSource: { kind: "workspace_connection", mechanism: "api_key" } },
    } as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>;
    let unavailable = 0;
    expect(
      configuredToolDecisionModel({
        settings: testSettings({ toolSearchDecisionModelId: "test/decision" }),
        runtime: { resolveTurnModel: () => route },
        recordUsage: async () => {},
        onUnavailable: () => {
          unavailable++;
        },
      }),
    ).toBeUndefined();
    expect(unavailable).toBe(1);
  });
  test("uses the ordinary provider's upstream model, minimal effort and usage hook", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const route = {
      provider: {
        id: "test",
        api: "chat",
        kind: "api-key",
        credentialSource: { kind: "deployment", mechanism: "api_key" },
      },
      client: {
        chat: {
          completions: {
            create: async (body: Record<string, unknown>) => {
              bodies.push(body);
              return {
                id: "decision-response",
                model: "small-model",
                choices: [
                  { finish_reason: "stop", message: { role: "assistant", content: '{"ids":[0]}' } },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
              };
            },
          },
        },
      },
      configured: {
        id: "test/decision",
        upstreamModelId: "small-model",
        capabilities: {
          reasoning: { runnable: true, efforts: ["high", "none"], defaultEffort: "high" },
        },
      },
    } as unknown as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>;
    const usage: Array<{ id: string; responseId: string | undefined }> = [];
    const choose = configuredToolDecisionModel({
      settings: testSettings({ toolSearchDecisionModelId: "test/decision" }),
      runtime: { resolveTurnModel: () => route },
      recordUsage: async (id, event) => {
        usage.push({ id, responseId: event.responseId });
      },
      onUnavailable: () => {
        throw new Error("available");
      },
    })!;
    expect(
      await choose({
        query: "read task",
        candidates: [{ name: "tasks__read", description: "Read task", inputFields: ["id"] }],
      }),
    ).toEqual(["tasks__read"]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.model).toBe("small-model");
    expect(bodies[0]!.reasoning_effort).toBe("none");
    expect(bodies[0]!.tools).toBeUndefined();
    expect(usage).toEqual([{ id: "test/decision", responseId: "decision-response" }]);
  });
});
