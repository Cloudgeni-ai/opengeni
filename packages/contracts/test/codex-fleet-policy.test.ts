import { describe, expect, test } from "bun:test";
import {
  CODEX_FLEET_POLICY_MAX_CANDIDATES,
  DEFAULT_CODEX_FLEET_POLICY_V1,
  createCodexFleetReplayRecordV1,
  effectiveCodexFleetCacheStateV1,
  evaluateCodexFleetDecisionV1,
  readCodexFleetReplayRecordV1,
  replayCodexFleetDecisionV1,
  type CodexFleetCandidateV1,
  type CodexFleetDecisionInputV1,
  type CodexFleetPolicyConfigV1,
} from "../src";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");

function candidate(
  key: string,
  patch: Omit<
    Partial<CodexFleetCandidateV1>,
    "quota" | "cache" | "observedBurn" | "inferredUnexplainedBurn"
  > & {
    quota?: Partial<CodexFleetCandidateV1["quota"]>;
    cache?: Partial<CodexFleetCandidateV1["cache"]>;
    observedBurn?: Partial<CodexFleetCandidateV1["observedBurn"]>;
    inferredUnexplainedBurn?: Partial<CodexFleetCandidateV1["inferredUnexplainedBurn"]>;
  } = {},
): CodexFleetCandidateV1 {
  return {
    key,
    status: patch.status ?? "active",
    allocatorEnabled: patch.allocatorEnabled ?? true,
    cooldownRemainingMs: patch.cooldownRemainingMs ?? null,
    activeLeaseCount: patch.activeLeaseCount ?? 0,
    quota: {
      primary: patch.quota?.primary ?? { usedPercent: 10, resetRemainingMs: 60 * 60_000 },
      secondary: patch.quota?.secondary ?? {
        usedPercent: 0,
        resetRemainingMs: 7 * 24 * 60 * 60_000,
      },
      checkedAgeMs: patch.quota?.checkedAgeMs ?? 0,
      confidence: patch.quota?.confidence ?? "high",
    },
    cache: {
      hitRatio: patch.cache?.hitRatio ?? null,
      sampledTokens: patch.cache?.sampledTokens ?? null,
      checkedAgeMs: patch.cache?.checkedAgeMs ?? null,
      confidence: patch.cache?.confidence ?? "unknown",
      state: patch.cache?.state ?? "unknown",
      thresholdObservedForMs: patch.cache?.thresholdObservedForMs ?? null,
    },
    observedBurn: {
      percentPerHour: patch.observedBurn?.percentPerHour ?? null,
      confidence: patch.observedBurn?.confidence ?? "unknown",
    },
    inferredUnexplainedBurn: {
      percentPerHour: patch.inferredUnexplainedBurn?.percentPerHour ?? null,
      confidence: patch.inferredUnexplainedBurn?.confidence ?? "unknown",
    },
    overlayKeys: patch.overlayKeys ?? [],
  };
}

function input(
  candidates: CodexFleetCandidateV1[],
  patch: Omit<Partial<CodexFleetDecisionInputV1>, "request" | "admission" | "candidates"> & {
    request?: Partial<CodexFleetDecisionInputV1["request"]>;
    admission?: Partial<CodexFleetDecisionInputV1["admission"]>;
  } = {},
): CodexFleetDecisionInputV1 {
  return {
    observedAtMs: patch.observedAtMs ?? NOW,
    request: {
      placement: patch.request?.placement ?? "new",
      priority: patch.request?.priority ?? "standard",
      currentCandidateKey: patch.request?.currentCandidateKey ?? null,
      waitAgeMs: patch.request?.waitAgeMs ?? 0,
      overlayKey: patch.request?.overlayKey ?? null,
      overlayMode: patch.request?.overlayMode ?? "none",
    },
    admission: {
      dynamicCapacityUnits: patch.admission?.dynamicCapacityUnits ?? null,
      inUseUnits: patch.admission?.inUseUnits ?? 0,
      queuedManagerCount: patch.admission?.queuedManagerCount ?? 0,
      emergencyFuseActive: patch.admission?.emergencyFuseActive ?? false,
    },
    candidates,
  };
}

function policy(patch: Partial<CodexFleetPolicyConfigV1>): CodexFleetPolicyConfigV1 {
  return { ...DEFAULT_CODEX_FLEET_POLICY_V1, ...patch };
}

describe("Codex fleet deterministic replay", () => {
  test("matches the hardcoded canonical SHA-256 replay vector", () => {
    const record = createCodexFleetReplayRecordV1(input([candidate("c00")]));
    expect(record.policyFingerprint).toBe(
      "37242772c8d081162e91d0af531f8fffd6c4a939c3f29d0eb0197f5cbc7d33dc",
    );
    expect(record.inputFingerprint).toBe(
      "985f1492cc6f02f92e35c688c28fc9d6ec1f070d2502832d6508c85a1eeddfa7",
    );
    expect(record.decisionFingerprint).toBe(
      "60eee29cb3d8485dbf3b44a6e2755c11901937e625790d0e0995c5038883b0e1",
    );
  });

  test("canonical candidate order produces byte-identical decisions and fingerprints", () => {
    const left = createCodexFleetReplayRecordV1(
      input([candidate("c02", { activeLeaseCount: 1 }), candidate("c00"), candidate("c01")]),
    );
    const right = createCodexFleetReplayRecordV1(
      input([candidate("c01"), candidate("c02", { activeLeaseCount: 1 }), candidate("c00")]),
    );

    expect(left.input.candidates.map((item) => item.key)).toEqual(["c00", "c01", "c02"]);
    expect(right.input).toEqual(left.input);
    expect(right.inputFingerprint).toBe(left.inputFingerprint);
    expect(right.decisionFingerprint).toBe(left.decisionFingerprint);
    expect(replayCodexFleetDecisionV1(left)).toEqual({
      matches: true,
      policyFingerprintMatches: true,
      inputFingerprintMatches: true,
      decisionFingerprintMatches: true,
      recordedDecisionFingerprintMatches: true,
      decision: left.decision,
    });
  });

  test("detects input tampering and rejects an inconsistent recorded decision", () => {
    const record = createCodexFleetReplayRecordV1(input([candidate("c00"), candidate("c01")]));
    record.input.candidates[0]!.activeLeaseCount = 10;

    const replay = replayCodexFleetDecisionV1(record);
    expect(replay.matches).toBe(false);
    expect(replay.inputFingerprintMatches).toBe(false);
    expect(replay.decisionFingerprintMatches).toBe(false);
    expect(replay.recordedDecisionFingerprintMatches).toBe(true);

    const truncationTamper = createCodexFleetReplayRecordV1(input([candidate("c00")]));
    truncationTamper.truncatedCandidateCount = 1;
    expect(replayCodexFleetDecisionV1(truncationTamper)).toMatchObject({
      matches: false,
      inputFingerprintMatches: false,
    });

    const malformed = createCodexFleetReplayRecordV1(input([candidate("c00"), candidate("c01")]));
    malformed.decision.selectedCandidateKey = "c99";
    expect(() => replayCodexFleetDecisionV1(malformed)).toThrow("internally inconsistent");
  });

  test("strict reader rejects unknown fields, weak digests, and malformed decisions", () => {
    const record = createCodexFleetReplayRecordV1(input([candidate("c00")]));
    expect(readCodexFleetReplayRecordV1(record)).toEqual(record);

    expect(() =>
      readCodexFleetReplayRecordV1({ ...record, privateCredentialId: "must-not-pass" }),
    ).toThrow("missing or unknown fields");
    expect(() => readCodexFleetReplayRecordV1({ ...record, inputFingerprint: "deadbeef" })).toThrow(
      "lowercase SHA-256",
    );
    expect(() =>
      readCodexFleetReplayRecordV1({
        ...record,
        decision: { ...record.decision, selectedCandidateKey: "c99" },
      }),
    ).toThrow("internally inconsistent");
    expect(() =>
      readCodexFleetReplayRecordV1({
        ...record,
        decision: {
          ...record.decision,
          scores: record.decision.scores.map((score) => ({
            ...score,
            eligible: true,
            rejectionReason: "quota_ceiling",
          })),
        },
      }),
    ).toThrow("score is internally inconsistent");
    expect(() =>
      readCodexFleetReplayRecordV1({
        ...record,
        decision: {
          ...record.decision,
          scores: [
            ...record.decision.scores,
            { ...record.decision.scores[0]!, candidateKey: "c99" },
          ],
        },
      }),
    ).toThrow("not a bounded array");
  });

  test("bounds snapshots, reports truncation, and retains the current affinity candidate", () => {
    const candidates = Array.from({ length: CODEX_FLEET_POLICY_MAX_CANDIDATES + 9 }, (_, index) =>
      candidate(`c${String(index).padStart(2, "0")}`),
    );
    const current = candidates.at(-1)!.key;
    const record = createCodexFleetReplayRecordV1(
      input(candidates, { request: { currentCandidateKey: current } }),
    );

    expect(record.input.candidates).toHaveLength(CODEX_FLEET_POLICY_MAX_CANDIDATES);
    expect(record.truncatedCandidateCount).toBe(9);
    expect(record.input.candidates.some((item) => item.key === current)).toBe(true);
    expect(record.decision.selectedCandidateKey).toBe(current);
  });

  test("rejects duplicate or secret-shaped candidate keys instead of ambiguous replay", () => {
    expect(() =>
      createCodexFleetReplayRecordV1(input([candidate("c00"), candidate("c00")])),
    ).toThrow("Duplicate Codex fleet candidate key");
    expect(() =>
      createCodexFleetReplayRecordV1(input([candidate("raw credential id with spaces")])),
    ).toThrow("opaque safe characters");
  });
});

describe("Codex fleet quota, burn, cache, and hysteresis", () => {
  test("missing or stale quota is explicit uncertainty, not pristine quota or a hard exclusion", () => {
    const decision = createCodexFleetReplayRecordV1(
      input([
        candidate("fresh", { quota: { primary: { usedPercent: 65, resetRemainingMs: 60_000 } } }),
        candidate("missing", {
          quota: {
            primary: { usedPercent: null, resetRemainingMs: null },
            secondary: { usedPercent: null, resetRemainingMs: null },
            checkedAgeMs: null,
            confidence: "unknown",
          },
        }),
        candidate("stale", {
          quota: {
            primary: { usedPercent: 99, resetRemainingMs: 60_000 },
            checkedAgeMs: 2 * 60 * 60_000,
            confidence: "high",
          },
        }),
      ]),
    ).decision;

    const missing = decision.scores.find((score) => score.candidateKey === "missing")!;
    const stale = decision.scores.find((score) => score.candidateKey === "stale")!;
    expect(missing.eligible).toBe(true);
    expect(missing.confidence).toBe("unknown");
    expect(missing.quotaPressure).toBe(5_000);
    expect(missing.uncertaintyPressure).toBeGreaterThan(0);
    expect(stale.eligible).toBe(true);
    expect(stale.confidence).toBe("unknown");
  });

  test("partial quota windows cannot claim high confidence or enforce a hard ceiling", () => {
    const decision = createCodexFleetReplayRecordV1(
      input([
        candidate("partial", {
          quota: {
            primary: { usedPercent: 99, resetRemainingMs: null },
            secondary: { usedPercent: 20, resetRemainingMs: 60_000 },
            confidence: "high",
          },
        }),
      ]),
    ).decision;
    expect(decision.scores[0]).toMatchObject({
      candidateKey: "partial",
      confidence: "low",
      eligible: true,
    });
  });

  test("fresh authoritative ceiling blocks a new placement while an elapsed reset clears it", () => {
    const blocked = createCodexFleetReplayRecordV1(
      input([candidate("c00", { quota: { primary: { usedPercent: 95, resetRemainingMs: 1 } } })]),
    ).decision;
    expect(blocked.outcome).toBe("none");
    expect(blocked.scores[0]).toMatchObject({ eligible: false, rejectionReason: "quota_ceiling" });

    const reset = createCodexFleetReplayRecordV1(
      input([candidate("c00", { quota: { primary: { usedPercent: 95, resetRemainingMs: 0 } } })]),
    ).decision;
    expect(reset).toMatchObject({ outcome: "selected", selectedCandidateKey: "c00" });
  });

  test("confidence-labeled unexplained burn changes pressure without becoming hard truth", () => {
    const base = [
      candidate("burn", {
        quota: { primary: { usedPercent: 10, resetRemainingMs: 60_000 } },
        inferredUnexplainedBurn: { percentPerHour: 80, confidence: "low" },
      }),
      candidate("steady", {
        quota: { primary: { usedPercent: 20, resetRemainingMs: 60_000 } },
      }),
    ];
    const low = createCodexFleetReplayRecordV1(input(base)).decision;
    const high = createCodexFleetReplayRecordV1(
      input([
        candidate("burn", {
          quota: { primary: { usedPercent: 10, resetRemainingMs: 60_000 } },
          inferredUnexplainedBurn: { percentPerHour: 80, confidence: "high" },
        }),
        base[1]!,
      ]),
    ).decision;

    expect(low.selectedCandidateKey).toBe("burn");
    expect(high.selectedCandidateKey).toBe("steady");
    expect(
      high.scores.find((score) => score.candidateKey === "burn")!.inferredBurnPressure,
    ).toBeGreaterThan(
      low.scores.find((score) => score.candidateKey === "burn")!.inferredBurnPressure,
    );
    expect(high.scores.find((score) => score.candidateKey === "burn")!.eligible).toBe(true);
  });

  test("known local observed burn affects runway separately from unexplained inference", () => {
    const decision = createCodexFleetReplayRecordV1(
      input([
        candidate("local-burn", {
          observedBurn: { percentPerHour: 80, confidence: "high" },
        }),
        candidate("steady", { quota: { primary: { usedPercent: 15, resetRemainingMs: 60_000 } } }),
      ]),
    ).decision;
    const burn = decision.scores.find((score) => score.candidateKey === "local-burn")!;
    expect(burn.observedBurnPressure).toBeGreaterThan(0);
    expect(burn.inferredBurnPressure).toBe(0);
    expect(burn.runwayPressure).toBeGreaterThan(0);
    expect(decision.selectedCandidateKey).toBe("steady");
  });

  test("cache collapse and recovery require support, dwell, and separate thresholds", () => {
    const healthy = candidate("current", {
      cache: {
        hitRatio: 0.2,
        sampledTokens: 100_000,
        checkedAgeMs: 0,
        confidence: "high",
        state: "healthy",
        thresholdObservedForMs: DEFAULT_CODEX_FLEET_POLICY_V1.cacheCollapseDwellMs - 1,
      },
    }).cache;
    expect(effectiveCodexFleetCacheStateV1(healthy, DEFAULT_CODEX_FLEET_POLICY_V1)).toBe("healthy");
    expect(
      effectiveCodexFleetCacheStateV1(
        {
          ...healthy,
          sampledTokens: DEFAULT_CODEX_FLEET_POLICY_V1.cacheMinimumSampledTokens - 1,
        },
        DEFAULT_CODEX_FLEET_POLICY_V1,
      ),
    ).toBe("unknown");
    expect(
      effectiveCodexFleetCacheStateV1(
        {
          ...healthy,
          thresholdObservedForMs: DEFAULT_CODEX_FLEET_POLICY_V1.cacheCollapseDwellMs,
        },
        DEFAULT_CODEX_FLEET_POLICY_V1,
      ),
    ).toBe("collapsed");

    const collapsed = {
      ...healthy,
      hitRatio: DEFAULT_CODEX_FLEET_POLICY_V1.cacheCollapseRecoveryThreshold - 0.01,
      state: "collapsed" as const,
      thresholdObservedForMs: DEFAULT_CODEX_FLEET_POLICY_V1.cacheRecoveryDwellMs * 2,
    };
    expect(effectiveCodexFleetCacheStateV1(collapsed, DEFAULT_CODEX_FLEET_POLICY_V1)).toBe(
      "collapsed",
    );
    expect(
      effectiveCodexFleetCacheStateV1(
        {
          ...collapsed,
          hitRatio: DEFAULT_CODEX_FLEET_POLICY_V1.cacheCollapseRecoveryThreshold,
          thresholdObservedForMs: DEFAULT_CODEX_FLEET_POLICY_V1.cacheRecoveryDwellMs,
        },
        DEFAULT_CODEX_FLEET_POLICY_V1,
      ),
    ).toBe("healthy");
  });

  test("healthy cache affinity preserves a warm home while cache collapse removes most switch cost", () => {
    const healthy = createCodexFleetReplayRecordV1(
      input(
        [
          candidate("current", {
            quota: { primary: { usedPercent: 40, resetRemainingMs: 60_000 } },
            cache: {
              hitRatio: 0.97,
              sampledTokens: 100_000,
              checkedAgeMs: 0,
              confidence: "high",
              state: "unknown",
              thresholdObservedForMs: DEFAULT_CODEX_FLEET_POLICY_V1.cacheRecoveryDwellMs,
            },
          }),
          candidate("cool", {
            quota: { primary: { usedPercent: 10, resetRemainingMs: 60_000 } },
          }),
        ],
        { request: { currentCandidateKey: "current" } },
      ),
    ).decision;
    const collapsed = createCodexFleetReplayRecordV1(
      input(
        [
          candidate("current", {
            quota: { primary: { usedPercent: 40, resetRemainingMs: 60_000 } },
            cache: {
              hitRatio: 0.05,
              sampledTokens: 100_000,
              checkedAgeMs: 0,
              confidence: "high",
              state: "healthy",
              thresholdObservedForMs: DEFAULT_CODEX_FLEET_POLICY_V1.cacheCollapseDwellMs,
            },
          }),
          candidate("cool", {
            quota: { primary: { usedPercent: 10, resetRemainingMs: 60_000 } },
          }),
        ],
        { request: { currentCandidateKey: "current" } },
      ),
    ).decision;

    expect(healthy).toMatchObject({ selectedCandidateKey: "current", reason: "affinity_best" });
    expect(collapsed).toMatchObject({ selectedCandidateKey: "cool", reason: "best_score" });
  });

  test("hysteresis holds small score improvements but permits a material runway advantage", () => {
    const current = candidate("current", {
      quota: { primary: { usedPercent: 20, resetRemainingMs: 60_000 } },
      cache: {
        hitRatio: 0.05,
        sampledTokens: 100_000,
        checkedAgeMs: 0,
        confidence: "high",
        state: "healthy",
        thresholdObservedForMs: DEFAULT_CODEX_FLEET_POLICY_V1.cacheCollapseDwellMs,
      },
    });
    const held = createCodexFleetReplayRecordV1(
      input(
        [
          current,
          candidate("challenger", {
            quota: { primary: { usedPercent: 10, resetRemainingMs: 60_000 } },
          }),
        ],
        { request: { currentCandidateKey: "current" } },
      ),
    ).decision;
    const moved = createCodexFleetReplayRecordV1(
      input(
        [
          current,
          candidate("challenger", {
            quota: { primary: { usedPercent: 0, resetRemainingMs: 60_000 } },
          }),
        ],
        { request: { currentCandidateKey: "current" } },
      ),
    ).decision;

    expect(held).toMatchObject({ selectedCandidateKey: "current", reason: "hysteresis_hold" });
    expect(moved).toMatchObject({ selectedCandidateKey: "challenger", reason: "best_score" });
  });

  test("active lease pressure spreads concurrent new placements without static slots", () => {
    const decision = createCodexFleetReplayRecordV1(
      input([candidate("busy", { activeLeaseCount: 3 }), candidate("idle")]),
    ).decision;
    expect(decision.selectedCandidateKey).toBe("idle");
  });
});

describe("Codex fleet admission, manager priority, borrowing, isolation, and fuse", () => {
  const admissionPolicy = policy({ admissionPacingEnabled: true, managerPriorityEnabled: true });

  test("standard work borrows every idle unit when no manager demand exists", () => {
    const decision = createCodexFleetReplayRecordV1(
      input([candidate("c00")], {
        admission: { dynamicCapacityUnits: 2, inUseUnits: 1, queuedManagerCount: 0 },
      }),
      admissionPolicy,
    ).decision;
    expect(decision.admission).toEqual({
      outcome: "admit",
      reason: "work_conserving_borrow",
      borrowedIdleCapacity: true,
    });
    expect(decision.outcome).toBe("selected");
  });

  test("manager priority paces standard work only while manager demand consumes all free units", () => {
    const standard = createCodexFleetReplayRecordV1(
      input([candidate("c00")], {
        admission: { dynamicCapacityUnits: 2, inUseUnits: 1, queuedManagerCount: 1 },
      }),
      admissionPolicy,
    ).decision;
    const manager = createCodexFleetReplayRecordV1(
      input([candidate("c00")], {
        request: { priority: "manager" },
        admission: { dynamicCapacityUnits: 2, inUseUnits: 1, queuedManagerCount: 1 },
      }),
      admissionPolicy,
    ).decision;

    expect(standard).toMatchObject({ outcome: "paced", reason: "admission_paced" });
    expect(standard.admission.reason).toBe("manager_priority");
    expect(manager).toMatchObject({ outcome: "selected" });
  });

  test("standard starvation bound eventually overrides manager preference", () => {
    const decision = createCodexFleetReplayRecordV1(
      input([candidate("c00")], {
        request: { waitAgeMs: admissionPolicy.managerStandardStarvationMs },
        admission: { dynamicCapacityUnits: 2, inUseUnits: 1, queuedManagerCount: 10 },
      }),
      admissionPolicy,
    ).decision;
    expect(decision.admission.reason).toBe("standard_starvation_bound");
    expect(decision.outcome).toBe("selected");
  });

  test("unknown dynamic capacity never invents a hard slot", () => {
    const decision = createCodexFleetReplayRecordV1(
      input([candidate("c00")]),
      admissionPolicy,
    ).decision;
    expect(decision.admission).toMatchObject({ outcome: "admit", reason: "capacity_unknown" });
  });

  test("emergency fuse paces only new work and never moves a fenced turn", () => {
    const fusePolicy = policy({ emergencyFuseEnabled: true });
    const fresh = createCodexFleetReplayRecordV1(
      input([candidate("c00")], { admission: { emergencyFuseActive: true } }),
      fusePolicy,
    ).decision;
    const fenced = createCodexFleetReplayRecordV1(
      input([candidate("c00", { allocatorEnabled: false })], {
        request: { placement: "fenced_in_flight", currentCandidateKey: "c00" },
        admission: { emergencyFuseActive: true },
      }),
      fusePolicy,
    ).decision;

    expect(fresh.admission.reason).toBe("emergency_fuse");
    expect(fresh.outcome).toBe("paced");
    expect(fenced).toMatchObject({
      outcome: "selected",
      selectedCandidateKey: "c00",
      reason: "fenced_in_flight",
    });
  });

  test("preferred overlays borrow globally, while explicit isolation reports stranded capacity", () => {
    const overlayPolicy = policy({ overlaysEnabled: true });
    const candidates = [candidate("c00"), candidate("c01")];
    const preferred = createCodexFleetReplayRecordV1(
      input(candidates, {
        request: { overlayKey: "named-a", overlayMode: "prefer" },
      }),
      overlayPolicy,
    ).decision;
    const isolated = createCodexFleetReplayRecordV1(
      input(candidates, {
        request: { overlayKey: "named-a", overlayMode: "isolate" },
      }),
      overlayPolicy,
    ).decision;

    expect(preferred).toMatchObject({ outcome: "selected", borrowedOverlayCapacity: true });
    expect(isolated).toMatchObject({
      outcome: "none",
      reason: "overlay_isolated_empty",
      strandedEligibleCount: 2,
    });
  });

  test("a pressured preferred member does not prevent borrowing from a healthy outsider", () => {
    const overlayPolicy = policy({ overlaysEnabled: true });
    const decision = createCodexFleetReplayRecordV1(
      input(
        [
          candidate("member", { activeLeaseCount: 4, overlayKeys: ["named-a"] }),
          candidate("outsider"),
        ],
        { request: { overlayKey: "named-a", overlayMode: "prefer" } },
      ),
      overlayPolicy,
    ).decision;

    expect(decision).toMatchObject({
      outcome: "selected",
      selectedCandidateKey: "outsider",
      borrowedOverlayCapacity: true,
      strandedEligibleCount: 0,
    });
    expect(decision.scores.every((score) => score.eligible)).toBe(true);
  });

  test("overlay changes are reversible and cannot affect an in-flight fence", () => {
    const overlayPolicy = policy({ overlaysEnabled: true });
    const candidates = [candidate("current"), candidate("member", { overlayKeys: ["named-a"] })];
    const isolated = evaluateCodexFleetDecisionV1(
      input(candidates, {
        request: {
          placement: "fenced_in_flight",
          currentCandidateKey: "current",
          overlayKey: "named-a",
          overlayMode: "isolate",
        },
      }),
      overlayPolicy,
    );
    const disabled = evaluateCodexFleetDecisionV1(
      input(candidates, {
        request: { currentCandidateKey: "current", overlayKey: "named-a", overlayMode: "isolate" },
      }),
      policy({ overlaysEnabled: false }),
    );

    expect(isolated.selectedCandidateKey).toBe("current");
    expect(disabled.outcome).toBe("selected");
    expect(disabled.strandedEligibleCount).toBe(0);
  });
});
