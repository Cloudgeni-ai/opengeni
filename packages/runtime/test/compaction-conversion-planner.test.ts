import { expect, test } from "bun:test";
import { conversionChunkKey, conversionDigest, type ConversionCheckpoint } from "@opengeni/codex";
import {
  rebuildCompactionConversation,
  planCompactionConversionStep,
} from "../src/compaction-conversion";

const target = { provider: "test", modelId: "test/model", connectionId: "connection" };
const budget = { inputTokens: 500, outputTokens: 150, calls: 100, totalTokens: 50_000 };
const countTokens = (text: string) => text.length;
function rebuild(items: Record<string, unknown>[]) {
  const result = rebuildCompactionConversation({
    rows: items.map((item, position) => ({
      id: `row-${position}`,
      position,
      item,
      turnId: "turn",
      createdAt: "2026-10-12T00:00:00Z",
    })),
    events: [],
  });
  if (!result.rebuilt) throw new Error(result.reason);
  return result;
}
const message = (text: string) => ({ type: "message", role: "user", content: text });

test("SUB-FAIL-09 all-unit coverage survives multiple bounded reductions without provider/tool calls", () => {
  const rebuilt = rebuild(
    Array.from({ length: 40 }, (_, i) => message(`${i} ${"full source ".repeat(25)}`)),
  );
  const checkpoints: ConversionCheckpoint[] = [];
  let reductions = 0;
  for (let calls = 0; calls < budget.calls; calls++) {
    const step = planCompactionConversionStep({
      rebuilt,
      target,
      budget,
      checkpoints,
      countTokens,
    });
    if (step.kind === "complete") {
      expect(step.checkpoint.coverage).toEqual(rebuilt.manifest.rows.map((row) => row.id));
      expect(reductions).toBeGreaterThan(2);
      expect(checkpoints.length).toBeGreaterThan(40);
      return;
    }
    expect(step.kind).toBe("request");
    if (step.kind !== "request") throw new Error(JSON.stringify(step));
    expect(step.tools).toBe("disabled");
    expect(step.chunk.inputTokens).toBeLessThanOrEqual(budget.inputTokens);
    expect(step.chunk.inputDigest).toBe(conversionDigest(step.text));
    if (step.chunk.children.length) reductions++;
    const summary = `Summary ${calls} ${"s".repeat(80)}`;
    checkpoints.push({ ...step.chunk, summary, outputTokens: summary.length });
  }
  throw new Error("planner never completed");
});

test("SUB-FAIL-09 indivisible tool units, unsupported content and orphan effects refuse actionably", () => {
  for (const items of [
    [message("huge".repeat(1000))],
    [
      message("start"),
      { type: "function_call", callId: "call", name: "tool", arguments: "{}" },
      { type: "function_call_result", callId: "call", output: "complete output ".repeat(100) },
    ],
    [message("start"), { type: "function_call", callId: "call", name: "tool", arguments: "{}" }],
    [{ type: "function_call_result", callId: "orphan", output: "result" }],
    [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "test-only" }] }],
    [{ type: "unknown", providerData: { type: "unsupported" } }],
  ]) {
    const step = planCompactionConversionStep({
      rebuilt: rebuild(items),
      target,
      budget,
      checkpoints: [],
      countTokens,
    });
    expect(step.kind).toBe("refused");
    if (step.kind === "refused")
      expect(["conversion_unit_exceeds_budget", "conversion_unsupported_content"]).toContain(
        step.reason,
      );
  }
});

test("SUB-FAIL-09 failures, non-reducing summaries and exhausted budgets never trim source", () => {
  const rebuilt = rebuild([message("full source ".repeat(30)), message("next ".repeat(60))]);
  const first = planCompactionConversionStep({
    rebuilt,
    target,
    budget,
    checkpoints: [],
    countTokens,
  });
  if (first.kind !== "request") throw new Error("expected request");
  for (const summary of ["", " ", first.text, "large".repeat(100)]) {
    const step = planCompactionConversionStep({
      rebuilt,
      target,
      budget,
      checkpoints: [{ ...first.chunk, summary, outputTokens: summary.length }],
      countTokens,
    });
    expect(step).toMatchObject({ kind: "refused", reason: "conversion_summary_failed" });
  }
  for (const constrained of [
    { ...budget, totalTokens: 10 },
    { ...budget, calls: 1 },
  ]) {
    const step = planCompactionConversionStep({
      rebuilt,
      target,
      budget: constrained,
      checkpoints: [],
      countTokens,
    });
    if (step.kind === "request") {
      expect(
        planCompactionConversionStep({
          rebuilt,
          target,
          budget: constrained,
          checkpoints: [{ ...step.chunk, summary: "summary", outputTokens: 7 }],
          countTokens,
        }),
      ).toMatchObject({ kind: "refused", reason: "conversion_budget_exhausted" });
    } else expect(step).toMatchObject({ kind: "refused", reason: "conversion_budget_exhausted" });
  }
});

test("SUB-FAIL-09 malicious manifests, gaps, duplicate coverage and unrelated checkpoints are rejected", () => {
  const rebuilt = rebuild([message("first source"), message("second source")]);
  const first = planCompactionConversionStep({
    rebuilt,
    target,
    budget,
    checkpoints: [],
    countTokens,
  });
  if (first.kind !== "request") throw new Error("request missing");
  const good = { ...first.chunk, summary: "summary", outputTokens: 7 };
  for (const checkpoint of [
    { ...good, coverage: ["row-0"] },
    { ...good, coverage: ["row-0", "row-0"] },
    { ...good, children: ["unrelated"] },
    { ...good, inputDigest: "bad" },
    {
      ...good,
      key: conversionChunkKey(
        rebuilt.manifest,
        { ...target, modelId: "other" },
        budget,
        first.chunk,
      ),
    },
  ])
    expect(
      planCompactionConversionStep({
        rebuilt,
        target,
        budget,
        checkpoints: [checkpoint],
        countTokens,
      }),
    ).toMatchObject({ kind: "refused", reason: "conversion_coverage_invalid" });
  expect(
    planCompactionConversionStep({
      rebuilt: { ...rebuilt, manifest: { ...rebuilt.manifest, rows: [] } },
      target,
      budget,
      checkpoints: [],
      countTokens,
    }),
  ).toMatchObject({ kind: "refused", reason: "conversion_coverage_invalid" });
  expect(
    planCompactionConversionStep({
      rebuilt,
      target,
      budget,
      checkpoints: [good, good],
      countTokens,
    }),
  ).toMatchObject({ kind: "refused", reason: "conversion_coverage_invalid" });
});
