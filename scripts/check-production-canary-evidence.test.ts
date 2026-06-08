import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./check-production-canary-evidence.ts", import.meta.url).pathname;
const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

describe("production canary evidence checker", () => {
  it("passes strict production canary evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-prod-canary-"));
    const marker = join(dir, "marker.json");
    writeFileSync(marker, JSON.stringify({ ok: true }));
    const evidence = writeEvidence(dir, marker, {});

    const result = runChecker("--evidence", evidence, "--expected-git-sha", "9557a39");

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.requiredChecks).toEqual([
      "production-deployment",
      "production-health",
      "managed-canary-smoke",
      "production-conformance",
      "billing-readonly",
      "observability-canary",
      "rollback-readiness",
    ]);
  });

  it("fails when a mandatory check is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-prod-canary-"));
    const marker = join(dir, "marker.json");
    writeFileSync(marker, JSON.stringify({ ok: true }));
    const evidence = writeEvidence(dir, marker, { omit: "production-conformance" });

    const result = runChecker("--evidence", evidence);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout).results.find((entry: { id: string }) => entry.id === "production-conformance").detail)
      .toContain("missing required production canary check production-conformance");
  });

  it("fails canary evidence for the wrong git SHA", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-prod-canary-"));
    const marker = join(dir, "marker.json");
    writeFileSync(marker, JSON.stringify({ ok: true }));
    const evidence = writeEvidence(dir, marker, {});

    const result = runChecker("--evidence", evidence, "--expected-git-sha", "aaaaaaaa");

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout).results.find((entry: { id: string }) => entry.id === "top-level-evidence").detail)
      .toContain("expected aaaaaaaa");
  });
});

function runChecker(...args: string[]): ReturnType<typeof spawnSync<string>> {
  return spawnSync("bun", [scriptPath, ...args], { encoding: "utf8" });
}

function writeEvidence(dir: string, marker: string, options: { omit?: string }): string {
  const checks = [
    check("production-deployment", marker, {
      deployedByPrivateOps: true,
      productionEnvironmentScoped: true,
      artifactDigestPinned: true,
      apiDigestPinned: true,
      workerDigestPinned: true,
      webDigestPinned: true,
    }),
    check("production-health", marker, {
      healthOk: true,
      clientConfigProduction: true,
      authModeManaged: true,
      httpsOnly: true,
    }),
    check("managed-canary-smoke", marker, {
      emailVerified: true,
      accountWorkspaceResolved: true,
      apiKeyCreated: true,
      canaryWorkspaceIsInternal: true,
    }),
    check("production-conformance", marker, {
      noSkippedChecks: true,
      sessionRun: true,
      eventReplay: true,
      sseReplay: true,
      mcpToolSession: true,
      scheduledTask: true,
      objectStorage: true,
    }),
    check("billing-readonly", marker, {
      billingEndpointReadable: true,
      creditStateReadable: true,
      noLiveChargeCreated: true,
    }),
    check("observability-canary", marker, {
      syntheticProbeConfigured: true,
      alertsConfigured: true,
      metricsVisible: true,
      traceCorrelationVerified: true,
      logCorrelationVerified: true,
    }),
    check("rollback-readiness", marker, {
      previousArtifactKnown: true,
      rollbackPlanDocumented: true,
      rollbackCredentialsAvailable: true,
      currentArtifactRestorable: true,
    }),
  ].filter((item) => item.id !== options.omit);

  const evidence = join(dir, "production-canary.json");
  writeFileSync(evidence, JSON.stringify({
    ok: true,
    environment: "production",
    baseUrl: "https://app.opengeni.ai",
    gitSha: "9557a39",
    generatedAt: "2026-06-08T00:00:00.000Z",
    images: {
      api: { image: `registry.example/opengeni-api:test@${digest}`, digest },
      worker: { image: `registry.example/opengeni-worker:test@${digest}`, digest },
      web: { image: `registry.example/opengeni-web:test@${digest}`, digest },
    },
    checks,
  }));
  return evidence;
}

function check(id: string, marker: string, metrics: Record<string, unknown>) {
  return {
    id,
    status: "passed",
    evidence: [marker],
    metrics,
  };
}
