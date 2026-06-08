import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./assemble-operational-readiness.ts", import.meta.url).pathname;

describe("operational readiness assembler", () => {
  it("assembles component checks into one readiness evidence file", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-readiness-"));
    const marker = join(dir, "marker.json");
    writeFileSync(marker, JSON.stringify({ ok: true }));
    const files = [
      checkFile(dir, "load-soak", marker, {
        durationSeconds: 1_800,
        requests: 600,
        sessionsCompleted: 25,
        errorRate: 0,
        p95Ms: 1_000,
      }),
      checkFile(dir, "backup-restore", marker, {
        backupPolicyEnabled: true,
        restoreDrillCompleted: true,
        restoredDatabaseValidated: true,
        restoredObjectStorageValidated: true,
        rpoSeconds: 300,
      }),
      checkFile(dir, "rollback", marker, {
        digestPinnedRollback: true,
        previousArtifactRestored: true,
        postRollbackConformancePassed: true,
        forwardRollConformancePassed: true,
        rollbackSeconds: 240,
      }),
      checkFile(dir, "observability-alerts", marker, {
        syntheticProbeConfigured: true,
        alertsConfigured: true,
        metricsDashboardVerified: true,
        traceCorrelationVerified: true,
        logCorrelationVerified: true,
      }),
      checkFile(dir, "private-ops-boundary", marker, {
        deployedByPrivateOps: true,
        publicPrSecretsBlocked: true,
        environmentSecretsScoped: true,
        oidcTrustScoped: true,
        artifactDigestPinned: true,
        secretScanPassed: true,
      }),
      checkFile(dir, "runtime-config", marker, {
        clientConfigMatchesExpected: true,
        configMapMatchesExpected: true,
        configSecretOverlapAbsent: true,
        runtimeEnvMatchesExpected: true,
        expectedReasoningEffort: "low",
        clientDefaultReasoningEffort: "low",
        configReasoningEffort: "low",
      }),
    ];
    const out = join(dir, "operational-readiness.json");

    const result = runAssembler(out, files);

    expect(result.status).toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.ok).toBe(true);
    expect(payload.checks.map((check: { id: string }) => check.id)).toEqual([
      "load-soak",
      "backup-restore",
      "rollback",
      "observability-alerts",
      "private-ops-boundary",
      "runtime-config",
    ]);
  });

  it("fails when required checks are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-readiness-"));
    const marker = join(dir, "marker.json");
    writeFileSync(marker, JSON.stringify({ ok: true }));
    const out = join(dir, "operational-readiness.json");

    const result = runAssembler(out, [checkFile(dir, "load-soak", marker, {})]);

    expect(result.status).not.toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.ok).toBe(false);
    expect(payload.failures).toContain("missing required operational check backup-restore");
  });
});

function runAssembler(out: string, files: string[]): ReturnType<typeof spawnSync<string>> {
  return spawnSync("bun", [
    scriptPath,
    "--out", out,
    "--environment", "staging",
    "--base-url", "https://staging.app.opengeni.ai",
    ...files.flatMap((file) => ["--check", file]),
  ], { encoding: "utf8" });
}

function checkFile(dir: string, id: string, marker: string, metrics: Record<string, unknown>): string {
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify({
    ok: true,
    checks: [{
      id,
      status: "passed",
      detail: id,
      evidence: [marker],
      metrics,
    }],
  }));
  return file;
}
