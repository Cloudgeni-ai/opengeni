import { describe, expect, test } from "bun:test";
import { replayCodexFleetDecisionV1 } from "@opengeni/contracts";
import type { CodexLeaseAccountStatus } from "@opengeni/db";
import { CancelledFailure } from "@temporalio/activity";
import {
  CODEX_FLEET_SHADOW_DECISION_MAX_METRIC_SERIES,
  CODEX_FLEET_SHADOW_ERROR_MAX_METRIC_SERIES,
  CODEX_FLEET_SHADOW_MAX_PAYLOAD_BYTES,
  buildCodexFleetShadowPayloadV1,
  codexFleetShadowDecisionMetricLabelsV1,
  codexFleetShadowErrorMetricLabelsV1,
  publishCodexFleetShadowDecisionV1,
} from "../src/activities/codex-fleet-shadow";
import { TurnAttemptFencedError } from "../src/activities/turn-attempt-fenced";

const NOW = new Date("2026-07-18T12:00:00.000Z");
const ALIAS_SEED = "00000000-0000-4000-8000-000000000001";

function account(
  id: string,
  patch: Partial<CodexLeaseAccountStatus> = {},
): CodexLeaseAccountStatus {
  return {
    id,
    chatgptAccountId: `upstream-${id}`,
    label: `private label ${id}`,
    accountEmail: `${id}@example.test`,
    planType: "pro",
    status: "active",
    allocatorEnabled: true,
    isActive: false,
    expiresAt: null,
    lastRefreshAt: null,
    lastError: `private error ${id}`,
    primaryUsedPercent: 20,
    primaryResetAt: new Date(NOW.getTime() + 60 * 60_000),
    secondaryUsedPercent: 30,
    secondaryResetAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000),
    usageCheckedAt: new Date(NOW.getTime() - 60_000),
    exhaustedUntil: null,
    connectorNamespaces: ["private.connector"],
    connectorsCheckedAt: NOW,
    activeLeaseCount: 0,
    selectionCount: 99,
    lastSelectedAt: NOW,
    ...patch,
  };
}

describe("Codex fleet shadow payload", () => {
  test("is deterministic, replayable, and contains no account identity or private metadata", () => {
    const accounts = [account("cred-secret-a"), account("cred-secret-b", { activeLeaseCount: 2 })];
    const args = {
      accounts,
      actualCredentialId: accounts[0]!.id,
      actualOutcome: "selected" as const,
      actualReason: "active" as const,
      affinityCredentialId: accounts[0]!.id,
      fencedInFlight: false,
      nearExhaustionPct: 90,
      now: NOW,
      aliasSeed: ALIAS_SEED,
    };
    const first = buildCodexFleetShadowPayloadV1(args);
    const second = buildCodexFleetShadowPayloadV1(args);

    expect(second).toEqual(first);
    expect(first.actual).toEqual({ outcome: "selected", candidateKey: "c00", reason: "active" });
    expect(first.comparison).toBe("match");
    expect(replayCodexFleetDecisionV1(first.replay).matches).toBe(true);
    expect(JSON.stringify(first)).not.toContain("cred-secret");
    expect(JSON.stringify(first)).not.toContain("example.test");
    expect(JSON.stringify(first)).not.toContain("private label");
    expect(JSON.stringify(first)).not.toContain("private error");
    expect(JSON.stringify(first)).not.toContain("private.connector");
    expect(first.replay.input.candidates.map((candidate) => candidate.key)).toEqual(["c00", "c01"]);
  });

  test("uses deterministic event-local aliases that are unlinkable across event seeds", () => {
    const accounts = [account("cred-a"), account("cred-b"), account("cred-c"), account("cred-d")];
    const build = (aliasSeed: string) =>
      buildCodexFleetShadowPayloadV1({
        accounts,
        actualCredentialId: "cred-a",
        actualOutcome: "selected",
        actualReason: "active",
        affinityCredentialId: "cred-a",
        fencedInFlight: false,
        nearExhaustionPct: 90,
        now: NOW,
        aliasSeed,
      });

    const first = build("seed-1");
    expect(build("seed-1")).toEqual(first);
    const second = build("seed-2");
    expect(first.actual.candidateKey).not.toBe(second.actual.candidateKey);
    expect(JSON.stringify([first, second])).not.toContain("cred-");
  });

  test("records all-capped actual-vs-shadow agreement without a credential id", () => {
    const payload = buildCodexFleetShadowPayloadV1({
      accounts: [
        account("cred-a", {
          primaryUsedPercent: 95,
          primaryResetAt: new Date(NOW.getTime() + 60_000),
        }),
      ],
      actualCredentialId: null,
      actualOutcome: "waiting",
      actualReason: "all_capped",
      affinityCredentialId: null,
      fencedInFlight: false,
      nearExhaustionPct: 90,
      now: NOW,
      aliasSeed: ALIAS_SEED,
    });

    expect(payload.actual).toEqual({
      outcome: "waiting",
      candidateKey: null,
      reason: "all_capped",
    });
    expect(payload.replay.decision.outcome).toBe("none");
    expect(payload.comparison).toBe("match");
  });

  test("a fenced turn is never shadow-moved even when allocator eligibility changes", () => {
    const payload = buildCodexFleetShadowPayloadV1({
      accounts: [account("cred-a", { allocatorEnabled: false }), account("cred-b")],
      actualCredentialId: "cred-a",
      actualOutcome: "selected",
      actualReason: "lease_reused",
      affinityCredentialId: "cred-a",
      fencedInFlight: true,
      nearExhaustionPct: 90,
      now: NOW,
      aliasSeed: ALIAS_SEED,
    });

    expect(payload.replay.decision).toMatchObject({
      outcome: "selected",
      selectedCandidateKey: payload.actual.candidateKey,
      reason: "fenced_in_flight",
    });
    expect(payload.comparison).toBe("match");
  });

  test("stale quota and unknown burn/cache remain confidence-labeled in durable input", () => {
    const payload = buildCodexFleetShadowPayloadV1({
      accounts: [
        account("cred-a", {
          usageCheckedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
        }),
      ],
      actualCredentialId: "cred-a",
      actualOutcome: "selected",
      actualReason: "active",
      affinityCredentialId: null,
      fencedInFlight: false,
      nearExhaustionPct: 90,
      now: NOW,
      aliasSeed: ALIAS_SEED,
    });
    const snapshot = payload.replay.input.candidates[0]!;

    expect(snapshot.quota).toMatchObject({ checkedAgeMs: 2 * 60 * 60_000, confidence: "high" });
    expect(payload.replay.decision.scores[0]!.confidence).toBe("unknown");
    expect(snapshot.cache).toMatchObject({ hitRatio: null, confidence: "unknown" });
    expect(snapshot.observedBurn).toEqual({ percentPerHour: null, confidence: "unknown" });
    expect(snapshot.inferredUnexplainedBurn).toEqual({
      percentPerHour: null,
      confidence: "unknown",
    });
  });

  test("keeps a maximal 32-candidate event under the explicit UTF-8 payload ceiling", async () => {
    const accounts = Array.from({ length: 32 }, (_, index) =>
      account(`credential-${index}-${"x".repeat(1_000)}`, {
        chatgptAccountId: `upstream-${"u".repeat(1_000)}`,
        label: `private-${"l".repeat(1_000)}`,
        accountEmail: `${"e".repeat(1_000)}@example.test`,
        lastError: `private-${"z".repeat(1_000)}`,
        connectorNamespaces: [`private.${"c".repeat(1_000)}`],
        primaryUsedPercent: 99.999,
        secondaryUsedPercent: 99.999,
        activeLeaseCount: 999_999,
      }),
    );
    const published: unknown[] = [];
    const result = await publishCodexFleetShadowDecisionV1({
      enabled: true,
      decision: {
        accounts,
        actualCredentialId: accounts.at(-1)!.id,
        actualOutcome: "selected",
        actualReason: "active",
        affinityCredentialId: accounts.at(-1)!.id,
        fencedInFlight: false,
        nearExhaustionPct: 90,
        now: NOW,
        aliasSeed: ALIAS_SEED,
      },
      publish: async (events) => {
        published.push(...events);
      },
    });

    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") throw new Error("expected bounded shadow publication");
    expect(result.payloadBytes).toBeLessThanOrEqual(CODEX_FLEET_SHADOW_MAX_PAYLOAD_BYTES);
    expect(result.payload.replay.input.candidates).toHaveLength(32);
    expect(published).toHaveLength(1);
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain("credential-");
    expect(serialized).not.toContain("example.test");
    expect(serialized).not.toContain("private-");
  });

  test("disabled shadow mode touches neither candidate data nor the event publisher", async () => {
    let published = false;
    const guardedAccounts = new Proxy([] as CodexLeaseAccountStatus[], {
      get() {
        throw new Error("disabled shadow mode inspected candidate data");
      },
    });
    const result = await publishCodexFleetShadowDecisionV1({
      enabled: false,
      decision: {
        accounts: guardedAccounts,
        actualCredentialId: "credential-secret",
        actualOutcome: "selected",
        actualReason: "active",
        affinityCredentialId: null,
        fencedInFlight: false,
        nearExhaustionPct: 90,
        now: NOW,
        aliasSeed: ALIAS_SEED,
      },
      publish: async () => {
        published = true;
      },
    });

    expect(result).toEqual({ outcome: "disabled" });
    expect(published).toBe(false);
  });

  test("publication failure is bounded, secret-safe, and cannot change the selected credential", async () => {
    const selectedCredentialId = "credential-selected-secret";
    const decision = {
      accounts: [account(selectedCredentialId)],
      actualCredentialId: selectedCredentialId,
      actualOutcome: "selected" as const,
      actualReason: "active" as const,
      affinityCredentialId: selectedCredentialId,
      fencedInFlight: false,
      nearExhaustionPct: 90,
      now: NOW,
      aliasSeed: ALIAS_SEED,
    };
    const result = await publishCodexFleetShadowDecisionV1({
      enabled: true,
      decision,
      publish: async () => {
        throw new Error(`database rejected ${selectedCredentialId}`);
      },
    });

    expect(result).toMatchObject({
      outcome: "failed",
      stage: "publish",
      reason: "unexpected",
      errorName: "Error",
    });
    expect(JSON.stringify(result)).not.toContain(selectedCredentialId);
    expect(decision.actualCredentialId).toBe(selectedCredentialId);
  });

  test("rethrows fencing and cancellation so no later caller mutation can run", async () => {
    const decision = {
      accounts: [account("credential-selected-secret")],
      actualCredentialId: "credential-selected-secret",
      actualOutcome: "selected" as const,
      actualReason: "active" as const,
      affinityCredentialId: null,
      fencedInFlight: false,
      nearExhaustionPct: 90,
      now: NOW,
      aliasSeed: ALIAS_SEED,
    };

    for (const lifecycleError of [
      new TurnAttemptFencedError("superseded"),
      new CancelledFailure("cancelled"),
    ]) {
      let laterMutationRan = false;
      const call = async () => {
        await publishCodexFleetShadowDecisionV1({
          enabled: true,
          decision,
          publish: async () => {
            throw lifecycleError;
          },
        });
        laterMutationRan = true;
      };
      await expect(call()).rejects.toBe(lifecycleError);
      expect(laterMutationRan).toBe(false);
    }
  });

  test("builds only fixed bounded metric labels with no tenant or workspace dimension", () => {
    const payload = buildCodexFleetShadowPayloadV1({
      accounts: [account("cred-a")],
      actualCredentialId: "cred-a",
      actualOutcome: "selected",
      actualReason: "active",
      affinityCredentialId: null,
      fencedInFlight: false,
      nearExhaustionPct: 90,
      now: NOW,
      aliasSeed: ALIAS_SEED,
    });
    const decisionLabels = codexFleetShadowDecisionMetricLabelsV1(payload);
    expect(Object.keys(decisionLabels).sort()).toEqual([
      "actual_outcome",
      "comparison",
      "confidence",
      "shadow_outcome",
      "truncated",
    ]);
    expect(JSON.stringify(decisionLabels)).not.toContain("workspace");
    expect(CODEX_FLEET_SHADOW_DECISION_MAX_METRIC_SERIES).toBe(288);

    const errorLabels = codexFleetShadowErrorMetricLabelsV1({
      outcome: "failed",
      stage: "publish",
      reason: "unexpected",
      errorName: "Error",
      payloadBytes: null,
    });
    expect(errorLabels).toEqual({ stage: "publish", reason: "unexpected" });
    expect(CODEX_FLEET_SHADOW_ERROR_MAX_METRIC_SERIES).toBe(6);
  });
});
