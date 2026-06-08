import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./check-operational-readiness.ts", import.meta.url).pathname;

describe("operational readiness checker", () => {
  it("passes strict structured operational evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-operational-"));
    const marker = join(dir, "marker.json");
    writeFileSync(marker, JSON.stringify({ ok: true }));
    const evidence = writeEvidence(dir, marker, {});

    const result = runChecker(evidence, { OPENGENI_LOAD_SOAK_MIN_SECONDS: "60" });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.requiredChecks).toEqual([
      "load-soak",
      "backup-restore",
      "rollback",
      "observability-alerts",
      "private-ops-boundary",
      "runtime-config",
    ]);
  });

  it("fails when a mandatory check is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-operational-"));
    const marker = join(dir, "marker.json");
    writeFileSync(marker, JSON.stringify({ ok: true }));
    const evidence = writeEvidence(dir, marker, { omit: "rollback" });

    const result = runChecker(evidence, { OPENGENI_LOAD_SOAK_MIN_SECONDS: "60" });

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout).results.find((entry: { id: string }) => entry.id === "rollback").detail)
      .toContain("missing required operational check rollback");
  });

  it("fails weak load evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-operational-"));
    const marker = join(dir, "marker.json");
    writeFileSync(marker, JSON.stringify({ ok: true }));
    const evidence = writeEvidence(dir, marker, { loadDurationSeconds: 30 });

    const result = runChecker(evidence, { OPENGENI_LOAD_SOAK_MIN_SECONDS: "60" });

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout).results.find((entry: { id: string }) => entry.id === "load-soak").detail)
      .toContain("durationSeconds 30 is below 60");
  });
});

function runChecker(evidence: string, env: Record<string, string> = {}): ReturnType<typeof spawnSync<string>> {
  return spawnSync("bun", [scriptPath, "--evidence", evidence, "--environment", "staging"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function writeEvidence(
  dir: string,
  marker: string,
  options: { omit?: string; loadDurationSeconds?: number },
): string {
  const checks = [
    {
      id: "load-soak",
      status: "passed",
      evidence: [marker],
      metrics: {
        durationSeconds: options.loadDurationSeconds ?? 120,
        requests: 750,
        sessionsCompleted: 50,
        errorRate: 0,
        p95Ms: 900,
      },
    },
    {
      id: "backup-restore",
      status: "passed",
      evidence: [marker],
      metrics: {
        backupPolicyEnabled: true,
        restoreDrillCompleted: true,
        restoredDatabaseValidated: true,
        restoredObjectStorageValidated: true,
        rpoSeconds: 300,
      },
    },
    {
      id: "rollback",
      status: "passed",
      evidence: [marker],
      metrics: {
        digestPinnedRollback: true,
        previousArtifactRestored: true,
        postRollbackConformancePassed: true,
        forwardRollConformancePassed: true,
        rollbackSeconds: 240,
      },
    },
    {
      id: "observability-alerts",
      status: "passed",
      evidence: [marker],
      metrics: {
        syntheticProbeConfigured: true,
        alertsConfigured: true,
        metricsDashboardVerified: true,
        traceCorrelationVerified: true,
        logCorrelationVerified: true,
      },
    },
    {
      id: "private-ops-boundary",
      status: "passed",
      evidence: [marker],
      metrics: {
        deployedByPrivateOps: true,
        publicPrSecretsBlocked: true,
        environmentSecretsScoped: true,
        oidcTrustScoped: true,
        artifactDigestPinned: true,
        secretScanPassed: true,
      },
    },
    {
      id: "runtime-config",
      status: "passed",
      evidence: [marker],
      metrics: {
        clientConfigMatchesExpected: true,
        configMapMatchesExpected: true,
        configSecretOverlapAbsent: true,
        runtimeEnvMatchesExpected: true,
        expectedReasoningEffort: "low",
        clientDefaultReasoningEffort: "low",
        configReasoningEffort: "low",
      },
    },
  ].filter((check) => check.id !== options.omit);

  const evidence = join(dir, "operational-readiness.json");
  writeFileSync(evidence, JSON.stringify({
    ok: true,
    environment: "staging",
    baseUrl: "https://staging.app.opengeni.ai",
    generatedAt: "2026-06-08T00:00:00.000Z",
    checks,
  }));
  return evidence;
}
