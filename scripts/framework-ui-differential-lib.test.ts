import { describe, expect, test } from "bun:test";
import {
  compareFrameworkUiTraces,
  normalizeFrameworkUiTrace,
  runFrameworkUiSensitivityProbes,
  type FrameworkUiRawTrace,
} from "./framework-ui-differential-lib";

function trace(
  generatedIds: readonly string[],
  timestamp: string,
  origin: string,
): FrameworkUiRawTrace {
  return {
    schemaVersion: 1,
    runtime: { lane: "ignored" },
    normalizationHints: {
      generatedIds,
      timestamps: [timestamp],
      origins: { api: origin },
    },
    records: [
      {
        kind: "composer",
        calls: [
          { action: "send", clientEventId: generatedIds[0], text: "first" },
          { action: "send", clientEventId: generatedIds[1], text: "second" },
        ],
        replayedKeys: [generatedIds[0], generatedIds[0]],
        generations: [1, 2],
        cursorSeries: [1, 2, 3],
        optionalAnswerPreserved: { outcome: "answered", answers: [] },
        focus: { tag: "button", ariaLabel: "Retry" },
        occurredAt: timestamp,
        endpoint: `${origin}/v1/workspaces/workspace-fixed/sessions/session-fixed`,
        cursor: "cursor-fixed",
      },
    ],
    finalResources: {
      readers: 0,
      streams: 0,
      listeners: 0,
      timers: 0,
      objectUrls: 0,
      owners: 0,
      controllers: 0,
    },
  };
}

describe("framework UI differential normalization", () => {
  test("normalizes only hinted allocation facts and role origins", () => {
    const baseline = trace(
      ["baseline-id-a", "baseline-id-b"],
      "2026-08-29T10:00:00.000Z",
      "http://127.0.0.1:31001",
    );
    const candidate = trace(
      ["candidate-id-a", "candidate-id-b"],
      "2026-08-29T10:00:07.000Z",
      "http://127.0.0.1:42002",
    );

    const comparison = compareFrameworkUiTraces(baseline, candidate);
    expect(comparison.equal).toBe(true);
    expect(comparison.differences).toEqual([]);
    expect(comparison.baseline).toEqual(comparison.candidate);
    expect(comparison.baseline).not.toHaveProperty("runtime");
    expect(comparison.baseline).not.toHaveProperty("normalizationHints");
  });

  test("does not normalize text, cursor, authority, error, or call-order drift", () => {
    const baseline = trace(
      ["baseline-id-a", "baseline-id-b"],
      "2026-08-29T10:00:00.000Z",
      "http://127.0.0.1:31001",
    );
    const candidate = structuredClone(
      trace(
        ["candidate-id-a", "candidate-id-b"],
        "2026-08-29T10:00:07.000Z",
        "http://127.0.0.1:42002",
      ),
    ) as Record<string, unknown>;
    const records = candidate.records as Array<Record<string, unknown>>;
    const calls = records[0]!.calls as Array<Record<string, unknown>>;
    calls.reverse();
    records[0]!.cursor = "cursor-regressed";
    calls[0]!.text = "changed text";
    records[0]!.authority = { subject: "different-subject" };
    records[0]!.error = { name: "TypeError", message: "different error" };

    const comparison = compareFrameworkUiTraces(baseline, candidate);
    expect(comparison.equal).toBe(false);
    expect(comparison.differences.map(({ path }) => path)).toContain("$.records[0].cursor");
    expect(comparison.differences.map(({ path }) => path)).toContain("$.records[0].authority");
    expect(comparison.differences.map(({ path }) => path)).toContain("$.records[0].error");
    expect(comparison.differences.some(({ path }) => path.includes(".calls[0]"))).toBe(true);
  });

  test("distinguishes same-key replay from two independently generated keys", () => {
    const baseline = trace(
      ["baseline-id-a", "baseline-id-b"],
      "2026-08-29T10:00:00.000Z",
      "http://127.0.0.1:31001",
    );
    const candidate = trace(
      ["candidate-id-a", "candidate-id-b"],
      "2026-08-29T10:00:07.000Z",
      "http://127.0.0.1:42002",
    ) as Record<string, unknown>;
    const records = candidate.records as Array<Record<string, unknown>>;
    records[0]!.replayedKeys = ["candidate-id-a", "candidate-id-b"];

    const comparison = compareFrameworkUiTraces(baseline, candidate);
    expect(comparison.equal).toBe(false);
    expect(comparison.differences).toContainEqual({
      path: "$.records[0].replayedKeys[1]",
      baseline: "<generated-id:1>",
      candidate: "<generated-id:2>",
    });
  });

  test("representative mutation probes all fail closed", () => {
    const normalized = normalizeFrameworkUiTrace(
      trace(
        ["baseline-id-a", "baseline-id-b"],
        "2026-08-29T10:00:00.000Z",
        "http://127.0.0.1:31001",
      ),
    );
    const probes = runFrameworkUiSensitivityProbes(normalized);
    expect(probes.map(({ id }) => id)).toEqual([
      "call-order",
      "generation-fencing",
      "final-owner-refcount",
      "cursor-monotonicity",
      "idempotency-reuse",
      "optional-answer-preservation",
      "focus-restoration",
      "resource-cleanup",
      "semantic-value",
    ]);
    expect(probes.every(({ detected, differenceCount }) => detected && differenceCount > 0)).toBe(
      true,
    );
  });
});
