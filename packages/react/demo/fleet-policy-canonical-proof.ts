import {
  DEFAULT_CODEX_FLEET_POLICY_V1,
  canonicalCodexFleetReplayJsonV1,
  createCodexFleetReplayRecordV1,
  type CodexFleetCandidateV1,
  type CodexFleetDecisionInputV1,
} from "@opengeni/contracts";

const ORDERING_KEYS = ["aa", "a_", "a:", "a0", "a.", "a-", "a", "A"] as const;

function candidate(key: string): CodexFleetCandidateV1 {
  return {
    key,
    status: "active",
    allocatorEnabled: true,
    cooldownRemainingMs: null,
    activeLeaseCount: 0,
    quota: {
      primary: { usedPercent: 10, resetRemainingMs: 60 * 60_000 },
      secondary: { usedPercent: 0, resetRemainingMs: 7 * 24 * 60 * 60_000 },
      checkedAgeMs: 0,
      confidence: "high",
    },
    cache: {
      hitRatio: null,
      sampledTokens: null,
      checkedAgeMs: null,
      confidence: "unknown",
      state: "unknown",
      thresholdObservedForMs: null,
    },
    observedBurn: {
      primaryPercentPerHour: null,
      secondaryPercentPerHour: null,
      confidence: "unknown",
    },
    inferredUnexplainedBurn: {
      primaryPercentPerHour: null,
      secondaryPercentPerHour: null,
      confidence: "unknown",
    },
    overlayKeys: [],
  };
}

/** Browser/Bun golden proof for code-unit ordering and exact truncation retention. */
export function createFleetPolicyCanonicalProof() {
  const input: CodexFleetDecisionInputV1 = {
    observedAtMs: Date.parse("2026-07-18T12:00:00.000Z"),
    request: {
      placement: "new",
      priority: "standard",
      currentCandidateKey: "aa",
      waitAgeMs: 0,
      overlayKey: null,
      overlayMode: "none",
    },
    admission: {
      dynamicCapacityUnits: null,
      inUseUnits: 0,
      queuedManagerCount: 0,
      emergencyFuseActive: false,
    },
    candidates: ORDERING_KEYS.map(candidate),
  };
  const record = createCodexFleetReplayRecordV1(input, {
    ...DEFAULT_CODEX_FLEET_POLICY_V1,
    maxCandidates: 4,
  });
  return {
    candidateKeys: record.input.candidates.map((item) => item.key),
    selectedCandidateKey: record.decision.selectedCandidateKey,
    truncatedCandidateCount: record.truncatedCandidateCount,
    canonicalJson: canonicalCodexFleetReplayJsonV1(record),
    policyFingerprint: record.policyFingerprint,
    inputFingerprint: record.inputFingerprint,
    decisionFingerprint: record.decisionFingerprint,
  };
}
