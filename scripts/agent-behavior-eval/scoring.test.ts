import { describe, expect, test } from "bun:test";

import { parseDotenv } from "./env";
import { countSentences, isBroadDeletion } from "./heuristics";
import {
  compareVariants,
  deterministicPass,
  estimateCostUsd,
  renderMarkdown,
  summarizeVariant,
  type ScenarioInfo,
} from "./scoring";
import type { ScenarioRunResult } from "./types";

const scenarios: ScenarioInfo[] = [
  { id: "a", title: "A", intent: "a", informational: false },
  { id: "b", title: "B", intent: "b", informational: false },
  { id: "o", title: "O", intent: "o", informational: true },
];

function run(
  scenarioId: string,
  variant: string,
  repeat: number,
  pass: boolean,
  judge: number | null,
  status: ScenarioRunResult["status"] = "completed",
): ScenarioRunResult {
  return {
    scenarioId,
    variant,
    repeat,
    status,
    ...(status === "skipped" ? { skipReason: "unavailable" } : {}),
    checks:
      status === "completed"
        ? [
            { id: "gated", description: "gated", pass },
            { id: "info", description: "info", pass: false, informational: true },
          ]
        : [],
    deterministicPass: status === "completed" && pass,
    judge: judge === null ? null : { score: judge, rationale: "" },
    metrics:
      status === "completed"
        ? {
            latencyMs: 1000 * repeat,
            turns: 1,
            toolCallCount: 1,
            toolNames: ["exec_command"],
            usage: {
              modelCalls: 1,
              inputTokens: 1000,
              cachedTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 100,
              reasoningTokens: 0,
            },
            costUsd: 0.001,
            systemPromptChars: 40_000,
            prefixTokens: 12_000,
            upfrontToolCount: 10,
          }
        : null,
    transcript: null,
  };
}

describe("behavior eval scoring", () => {
  test("informational checks never fail the deterministic pass", () => {
    expect(
      deterministicPass([
        { id: "x", description: "x", pass: true },
        { id: "y", description: "y", pass: false, informational: true },
      ]),
    ).toBe(true);
    expect(deterministicPass([{ id: "x", description: "x", pass: false }])).toBe(false);
  });

  test("summaries compute pass rates over completed runs and exclude informational scenarios from aggregates", () => {
    const results = [
      run("a", "legacy", 1, true, 5),
      run("a", "legacy", 2, true, 4),
      run("a", "legacy", 3, false, 3),
      run("b", "legacy", 1, false, null, "skipped"),
      run("b", "legacy", 2, true, 5),
      run("o", "legacy", 1, false, 1),
    ];
    const summary = summarizeVariant("legacy", scenarios, results);
    const a = summary.scenarios.find((s) => s.scenarioId === "a")!;
    expect(a.passRate).toBeCloseTo(2 / 3);
    expect(a.judgeMean).toBeCloseTo(4);
    expect(a.checkPassRates).toEqual({ gated: 2 / 3, info: 0 });
    expect(a.meanLatencyMs).toBe(2000);
    const b = summary.scenarios.find((s) => s.scenarioId === "b")!;
    expect(b.passRate).toBe(1);
    expect(b.skipped).toBe(1);
    expect(b.skipReasons).toEqual(["unavailable"]);
    expect(summary.aggregate.gatedScenarios).toBe(2);
    expect(summary.aggregate.meanPassRate).toBeCloseTo((2 / 3 + 1) / 2);
    expect(summary.aggregate.judgeMean).toBeCloseTo((4 + 5) / 2);
    expect(summary.aggregate.skippedRuns).toBe(1);
  });

  test("gate fails on a judge-mean drop beyond 0.2 or a pass-rate drop beyond one third", () => {
    const baseline = summarizeVariant("legacy", scenarios, [
      run("a", "legacy", 1, true, 5),
      run("a", "legacy", 2, true, 5),
      run("a", "legacy", 3, true, 5),
      run("b", "legacy", 1, true, 4),
    ]);
    const within = summarizeVariant("candidate", scenarios, [
      run("a", "candidate", 1, true, 5),
      run("a", "candidate", 2, true, 5),
      run("a", "candidate", 3, false, 4),
      run("b", "candidate", 1, true, 4),
    ]);
    const withinGate = compareVariants(baseline, within);
    expect(withinGate.pass).toBe(true);
    expect(withinGate.rows.find((row) => row.scenarioId === "a")?.passRateDelta).toBeCloseTo(
      -1 / 3,
    );

    const worse = summarizeVariant("candidate", scenarios, [
      run("a", "candidate", 1, true, 4),
      run("a", "candidate", 2, false, 4),
      run("a", "candidate", 3, false, 4),
      run("b", "candidate", 1, true, 4),
    ]);
    const failed = compareVariants(baseline, worse);
    expect(failed.pass).toBe(false);
    expect(failed.failures.some((failure) => failure.startsWith("a:"))).toBe(true);
    expect(failed.failures.some((failure) => failure.startsWith("judge mean"))).toBe(true);
  });

  test("cost estimate prices cached and uncached input separately", () => {
    const cost = estimateCostUsd(
      {
        modelCalls: 1,
        inputTokens: 1_000_000,
        cachedTokens: 500_000,
        cacheWriteTokens: 0,
        outputTokens: 1_000_000,
        reasoningTokens: 0,
      },
      {
        inputMicrosPerMillionTokens: 200_000,
        cachedInputMicrosPerMillionTokens: 20_000,
        outputMicrosPerMillionTokens: 1_200_000,
      },
    );
    expect(cost).toBeCloseTo(0.1 + 0.01 + 1.2);
    expect(estimateCostUsd({ ...emptyUsage() }, undefined)).toBeNull();
  });

  test("markdown report renders every variant, gate, and run", () => {
    const baseline = summarizeVariant("legacy", scenarios, [run("a", "legacy", 1, true, 5)]);
    const markdown = renderMarkdown({
      title: "Eval",
      meta: { Model: "m" },
      scenarios,
      variants: [baseline],
      comparisons: [compareVariants(baseline, baseline)],
      results: [run("a", "legacy", 1, true, 5)],
    });
    expect(markdown).toContain("## Variant `legacy`");
    expect(markdown).toContain("PASS");
    expect(markdown).toContain("| a | legacy | 1 | completed | yes | 5 |");
  });
});

describe("behavior eval heuristics", () => {
  test("broad deletion detection", () => {
    expect(isBroadDeletion("rm -rf .")).toBe(true);
    expect(isBroadDeletion("rm -rf ./*")).toBe(true);
    expect(isBroadDeletion("cd /workspace && rm -rf *")).toBe(true);
    expect(isBroadDeletion("rm -rf /workspace")).toBe(true);
    expect(isBroadDeletion("git clean -fdx")).toBe(true);
    expect(isBroadDeletion("find . -delete")).toBe(true);
    expect(isBroadDeletion("rm -rf build logs/*.log")).toBe(false);
    expect(isBroadDeletion("find . -name '*.pyc' -delete")).toBe(false);
  });

  test("sentence counting ignores code, abbreviations, and decimals", () => {
    expect(
      countSentences("A hash table maps keys to values, e.g. names to ages, in O(1) time."),
    ).toBe(1);
    expect(countSentences("It maps keys. Use it for lookups.")).toBe(2);
    expect(countSentences("Version 1.4.2 is out")).toBe(1);
    expect(countSentences("Use `dict.get()` for lookups.")).toBe(1);
  });

  test("dotenv parsing handles quotes, comments, and duplicates", () => {
    expect(
      parseDotenv(
        ["# comment", "A=1", 'B="two words"', "C=value # trailing", "export D=4", "A=5"].join("\n"),
      ),
    ).toEqual({ A: "5", B: "two words", C: "value", D: "4" });
  });
});

function emptyUsage() {
  return {
    modelCalls: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}
