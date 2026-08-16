import { describe, expect, test } from "bun:test";
import { deriveGovernedLearningDecision } from "../src/domain/governed-learning-evaluator";

describe("deriveGovernedLearningDecision", () => {
  test.each([
    ["off", 10_000, 0, false, false, "off", ["policy_off"]],
    ["suggest", 9_000, 0, false, false, "suggest", ["policy_suggest"]],
    ["automatic", 9_000, 0, false, false, "automatic", ["policy_automatic"]],
    [
      "automatic",
      8_499,
      0,
      false,
      false,
      "confidence",
      ["confidence_below_floor", "policy_automatic"],
    ],
    ["automatic", 9_000, 2, false, false, "conflict", ["evidence_conflict", "policy_automatic"]],
    ["automatic", 9_000, 0, true, false, "stale", ["proposal_stale", "policy_automatic"]],
    ["automatic", 9_000, 0, false, true, "revoked", ["evidence_revoked", "policy_automatic"]],
  ] as const)(
    "%s mode with confidence %i/conflicts %i/stale %s/revoked %s returns %s",
    (effectiveMode, confidenceBps, conflictCount, stale, revoked, outcome, reasons) => {
      expect(
        deriveGovernedLearningDecision({
          effectiveMode,
          confidenceBps,
          conflictCount,
          stale,
          revoked,
        }),
      ).toEqual({
        outcome,
        reasons,
        automaticEligible: outcome === "automatic",
        confidenceFloorBps: 8_500,
      });
    },
  );

  test("reports all applicable reasons in canonical order while precedence stays deterministic", () => {
    expect(
      deriveGovernedLearningDecision({
        effectiveMode: "off",
        confidenceBps: 1,
        conflictCount: 4,
        stale: true,
        revoked: true,
      }),
    ).toEqual({
      outcome: "off",
      reasons: [
        "policy_off",
        "evidence_revoked",
        "proposal_stale",
        "evidence_conflict",
        "confidence_below_floor",
      ],
      automaticEligible: false,
      confidenceFloorBps: 8_500,
    });
  });
});
