import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { turnRecoveryCauseForCode } from "../src/activities/agent-turn/provider-recovery-metrics";
import {
  FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE,
  MCP_SERVICE_UNAVAILABLE_RECOVERY_CODE,
  PROVIDER_UNREACHABLE_RECOVERY_CODE,
} from "../src/activities/agent-turn/provider-recovery-policy";
import {
  initializeWorkerOutcomeMetrics,
  recordWorkerDeathRecoveryMetrics,
  TurnLifecycleMetrics,
} from "../src/observability-metrics";

function worker() {
  return createObservability(testSettings(), { component: "worker" });
}

describe("turn recovery causes", () => {
  test("classifies run-failure recovery codes into a closed cause set", () => {
    expect(turnRecoveryCauseForCode("provider_unavailable")).toBe("provider");
    expect(turnRecoveryCauseForCode("provider_overloaded")).toBe("provider");
    expect(turnRecoveryCauseForCode("provider_rate_limited")).toBe("provider");
    expect(turnRecoveryCauseForCode(PROVIDER_UNREACHABLE_RECOVERY_CODE)).toBe("provider");
    expect(turnRecoveryCauseForCode(FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE)).toBe("tool");
    expect(turnRecoveryCauseForCode(MCP_SERVICE_UNAVAILABLE_RECOVERY_CODE)).toBe("tool");
    expect(turnRecoveryCauseForCode("mcp_transport_unavailable")).toBe("tool");
    expect(turnRecoveryCauseForCode("something_new")).toBe("other");
    expect(turnRecoveryCauseForCode(undefined)).toBe("other");
  });

  test("counts each recovering attempt once by cause, alongside the turn outcome", async () => {
    const observability = worker();
    initializeWorkerOutcomeMetrics(observability);
    const lifecycle = new TurnLifecycleMetrics(observability, { refreshIntervalMs: 60_000 });
    lifecycle.start({ attemptId: "a" });
    lifecycle.finish({ attemptId: "a", outcome: "recovering", recoveryCause: "provider" });
    lifecycle.start({ attemptId: "b" });
    lifecycle.finish({ attemptId: "b", outcome: "recovering" });
    lifecycle.start({ attemptId: "c" });
    lifecycle.finish({ attemptId: "c", outcome: "completed", recoveryCause: "sandbox" });
    recordWorkerDeathRecoveryMetrics(observability, {
      outcome: "recovering",
      timeoutType: "HEARTBEAT",
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turn_recoveries_total\{[^}]*cause="provider"[^}]*\} 1\b/);
    // An unset cause is never dropped; it is counted as other.
    expect(metrics).toMatch(/opengeni_turn_recoveries_total\{[^}]*cause="other"[^}]*\} 1\b/);
    expect(metrics).toMatch(/opengeni_turn_recoveries_total\{[^}]*cause="worker"[^}]*\} 1\b/);
    // A completed attempt never counts as a recovery, and every cause is published at zero.
    expect(metrics).toMatch(/opengeni_turn_recoveries_total\{[^}]*cause="sandbox"[^}]*\} 0\b/);
    expect(metrics).toMatch(/opengeni_turn_recoveries_total\{[^}]*cause="database"[^}]*\} 0\b/);
    expect(metrics).toMatch(/opengeni_turn_recoveries_total\{[^}]*cause="route_change"[^}]*\} 0\b/);
    expect(metrics).toMatch(/opengeni_turns_total\{[^}]*outcome="recovering"[^}]*\} 3\b/);
  });
});
