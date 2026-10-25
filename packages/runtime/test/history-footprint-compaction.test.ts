import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import {
  CompactionNeededError,
  contextRobustnessFilterForSettings,
  countModelInputImages,
  providerRequestImageLimit,
  type HistoryFootprintCompactionSignal,
} from "../src/index";

const settings = testSettings({
  contextWindowTokens: 1_000_000,
  contextAutoCompactThresholdTokens: 900_000,
});

function screenshotStep(step: number) {
  return [
    { type: "function_call", callId: `c${step}`, name: "browser_screenshot", arguments: "{}" },
    {
      type: "function_call_result",
      callId: `c${step}`,
      output: [
        { type: "input_text", text: `step ${step}` },
        { type: "input_image", image: "data:image/png;base64,AAAA" },
      ],
    },
  ];
}

async function callFilter(
  filter: ReturnType<typeof contextRobustnessFilterForSettings>,
  input: unknown[],
) {
  return await filter({
    modelData: { input: input as any, instructions: "system" },
    agent: {} as any,
    context: undefined,
  });
}

async function compactionError(promise: Promise<unknown>): Promise<CompactionNeededError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CompactionNeededError);
    return error as CompactionNeededError;
  }
  throw new Error("expected the request to compact first");
}

describe("history footprint compaction triggers", () => {
  test("the stored footprint signal compacts before a request far below the token threshold", async () => {
    let stored: HistoryFootprintCompactionSignal | null = null;
    const filter = contextRobustnessFilterForSettings(settings, {
      throwOnCompactionNeeded: true,
      historyFootprintCompaction: { storedFootprint: () => stored },
    });
    const input = [{ type: "message", role: "user", content: "start" }, ...screenshotStep(0)];
    const passed = await callFilter(filter, input);
    // No signal: the request passes through unchanged.
    expect(passed.input).toEqual(input as any);

    stored = { dimension: "json_bytes", actual: 9_500_000, threshold: 9_437_184 };
    const error = await compactionError(callFilter(filter, input));
    expect(error.signalSource).toBe("history_footprint");
    expect(error.trigger).toBe("threshold");
    expect(error.historyFootprint).toEqual(stored);
    expect(error.message).toBe(
      "Context compaction needed: active history json_bytes 9500000 reached threshold 9437184",
    );
  });

  test("the request image count compacts at the provider's threshold", async () => {
    const filter = contextRobustnessFilterForSettings(settings, {
      throwOnCompactionNeeded: true,
      historyFootprintCompaction: { imageThreshold: 3 },
    });
    const input: unknown[] = [{ type: "message", role: "user", content: "start" }];
    input.push(...screenshotStep(0), ...screenshotStep(1));
    await callFilter(filter, input);
    input.push(...screenshotStep(2));
    const error = await compactionError(callFilter(filter, input));
    expect(error.signalSource).toBe("history_footprint");
    expect(error.historyFootprint).toEqual({ dimension: "images", actual: 3, threshold: 3 });
  });

  test("without a threshold or signal the footprint options never compact", async () => {
    const filter = contextRobustnessFilterForSettings(settings, {
      throwOnCompactionNeeded: true,
      historyFootprintCompaction: { imageThreshold: null, storedFootprint: () => null },
    });
    const input: unknown[] = [];
    for (let step = 0; step < 50; step += 1) input.push(...screenshotStep(step));
    await callFilter(filter, input);
  });

  test("counts every native image part and bare image data URL", () => {
    expect(countModelInputImages(screenshotStep(0)[1])).toBe(1);
    expect(
      countModelInputImages({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "data:image/png;base64,AAAA is just text here" },
          { type: "input_image", image: "data:image/png;base64,AAAA" },
          { type: "input_image", fileId: "file_1" },
        ],
      }),
    ).toBe(2);
    expect(
      countModelInputImages({
        type: "computer_call_result",
        output: { type: "computer_screenshot", data: "data:image/png;base64,AAAA" },
      }),
    ).toBe(1);
    expect(
      countModelInputImages({ type: "function_call_result", output: "data:image/png;base64,AAAA" }),
    ).toBe(1);
    expect(countModelInputImages({ type: "message", role: "user", content: "no images" })).toBe(0);
  });

  test("per-request image limits follow each provider's documentation", () => {
    expect(providerRequestImageLimit({ api: "responses", wireProfile: "openai" }, 272_000)).toBe(
      1_500,
    );
    expect(
      providerRequestImageLimit({ api: "responses", wireProfile: "azure-openai" }, 272_000),
    ).toBe(50);
    expect(providerRequestImageLimit({ api: "anthropic-messages" }, 200_000)).toBe(100);
    expect(providerRequestImageLimit({ api: "anthropic-messages" }, 1_000_000)).toBe(600);
    expect(providerRequestImageLimit({ api: "chat", wireProfile: "openai" }, 272_000)).toBeNull();
  });
});
