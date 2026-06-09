import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./check-release-evidence.ts", import.meta.url).pathname;
const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

describe("release evidence checker", () => {
  it("passes required scopes with digest-pinned images and positive evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-evidence-"));
    const evidence = join(dir, "conformance.json");
    writeFileSync(evidence, JSON.stringify({ ok: true, results: [{ id: "health", status: "passed" }] }));
    const manifest = writeManifest(dir, [{
      id: "local-check-workspace-billing",
      status: "passed",
      requiredFor: ["local"],
      evidence: [evidence],
    }]);

    const result = runChecker("--manifest", manifest, "--require", "local", "--allow-dirty", "--allow-different-git-sha");

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.requiredScopes).toEqual(["local"]);
  });

  it("fails passed gates when JSON evidence explicitly failed", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-evidence-"));
    const evidence = join(dir, "conformance.json");
    writeFileSync(evidence, JSON.stringify({ ok: false, results: [{ id: "object-storage", status: "failed" }] }));
    const manifest = writeManifest(dir, [{
      id: "preview-conformance",
      status: "passed",
      requiredFor: ["preview"],
      evidence: [evidence],
    }]);

    const result = runChecker("--manifest", manifest, "--require", "preview", "--allow-dirty", "--allow-different-git-sha");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("top-level ok is false");
  });

  it("fails required JSON evidence that is not parseable JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-evidence-"));
    const evidence = join(dir, "conformance.json");
    writeFileSync(evidence, "$ bun scripts/conformance.ts\n{\"ok\":true}");
    const manifest = writeManifest(dir, [{
      id: "preview-conformance",
      status: "passed",
      requiredFor: ["preview"],
      evidence: [evidence],
    }]);

    const result = runChecker("--manifest", manifest, "--require", "preview", "--allow-dirty", "--allow-different-git-sha");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid JSON");
  });

  it("fails skipped required gates", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-evidence-"));
    const evidence = join(dir, "ledger.md");
    writeFileSync(evidence, "not ready");
    const manifest = writeManifest(dir, [{
      id: "production-canary",
      status: "skipped",
      requiredFor: ["customer-ready"],
      evidence: [evidence],
      detail: "not run",
    }]);

    const result = runChecker("--manifest", manifest, "--require", "customer-ready", "--allow-dirty", "--allow-different-git-sha");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("required gate production-canary is skipped");
  });

  it("fails customer-ready manifests that omit mandatory gates", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-evidence-"));
    const evidence = join(dir, "conformance.json");
    writeFileSync(evidence, JSON.stringify({ ok: true }));
    const manifest = writeManifest(dir, [{
      id: "production-canary",
      status: "passed",
      requiredFor: ["customer-ready"],
      evidence: [evidence],
    }]);

    const result = runChecker("--manifest", manifest, "--require", "customer-ready", "--allow-dirty", "--allow-different-git-sha");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing mandatory gate local-check-workspace-billing");
    expect(result.stderr).toContain("missing mandatory gate stripe-live-mode-readonly-preflight");
    expect(result.stderr).toContain("missing mandatory gate staging-load-soak");
    expect(result.stderr).toContain("missing mandatory gate staging-runtime-config");
  });

  it("fails passed production canary gates with weak JSON evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-evidence-"));
    const evidence = join(dir, "production-canary.json");
    writeFileSync(evidence, JSON.stringify({ ok: true }));
    const manifest = writeManifest(dir, [{
      id: "production-canary",
      status: "passed",
      requiredFor: ["production-canary"],
      evidence: [evidence],
    }]);

    const result = runChecker("--manifest", manifest, "--require", "production-canary", "--allow-dirty", "--allow-different-git-sha");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("production canary environment is <missing>");
  });

  it("passes production canary scope with strict canary evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-evidence-"));
    const marker = join(dir, "marker.json");
    writeFileSync(marker, JSON.stringify({ ok: true }));
    const evidence = join(dir, "production-canary.json");
    writeFileSync(evidence, JSON.stringify(productionCanaryEvidence(marker)));
    const manifest = writeManifest(dir, [{
      id: "production-canary",
      status: "passed",
      requiredFor: ["production-canary"],
      evidence: [evidence],
    }]);

    const result = runChecker("--manifest", manifest, "--require", "production-canary", "--allow-dirty", "--allow-different-git-sha");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).gatesChecked).toEqual(["production-canary"]);
  });

  it("fails preview scope when deployment evidence is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-evidence-"));
    const evidence = join(dir, "conformance.json");
    writeFileSync(evidence, JSON.stringify({ ok: true, results: [{ id: "health", status: "passed" }] }));
    const manifest = writeManifest(dir, [{
      id: "preview-conformance",
      status: "passed",
      requiredFor: ["preview"],
      evidence: [evidence],
    }]);

    const result = runChecker("--manifest", manifest, "--require", "preview", "--allow-dirty", "--allow-different-git-sha");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing mandatory gate preview-deployment");
  });

  it("passes preview scope with strict deployment evidence and all mandatory preview gates", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-evidence-"));
    const marker = join(dir, "marker.json");
    writeFileSync(marker, JSON.stringify({ ok: true }));
    const previewDeployment = join(dir, "preview-deployment.json");
    writeFileSync(previewDeployment, JSON.stringify(previewDeploymentEvidence()));
    const manifest = writeManifest(dir, [
      gate("preview-deployment", previewDeployment),
      gate("preview-managed-smoke", marker),
      gate("preview-stripe-checkout", marker),
      gate("preview-conformance", marker),
      gate("preview-usage-ledger", marker),
      gate("preview-web-console-smoke", marker),
    ]);

    const result = runChecker("--manifest", manifest, "--require", "preview", "--allow-dirty", "--allow-different-git-sha");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).gatesChecked).toEqual([
      "preview-deployment",
      "preview-managed-smoke",
      "preview-stripe-checkout",
      "preview-conformance",
      "preview-usage-ledger",
      "preview-web-console-smoke",
    ]);
  });

  it("fails staging scope when deployment evidence is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-evidence-"));
    const evidence = join(dir, "conformance.json");
    writeFileSync(evidence, JSON.stringify({ ok: true, results: [{ id: "health", status: "passed" }] }));
    const manifest = writeManifest(dir, [{
      id: "staging-conformance",
      status: "passed",
      requiredFor: ["staging"],
      evidence: [evidence],
    }]);

    const result = runChecker("--manifest", manifest, "--require", "staging", "--allow-dirty", "--allow-different-git-sha");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing mandatory gate staging-deployment");
  });

  it("passes staging scope with strict deployment evidence and all mandatory staging gates", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-evidence-"));
    const marker = join(dir, "marker.json");
    writeFileSync(marker, JSON.stringify({ ok: true }));
    const stagingDeployment = join(dir, "staging-deployment.json");
    writeFileSync(stagingDeployment, JSON.stringify(stagingDeploymentEvidence()));
    const manifest = writeManifest(dir, [
      gate("staging-deployment", stagingDeployment, "staging"),
      gate("staging-managed-smoke", marker, "staging"),
      gate("staging-stripe-checkout", marker, "staging"),
      gate("staging-conformance", marker, "staging"),
      gate("staging-usage-ledger", marker, "staging"),
      gate("staging-github-private-resource", marker, "staging"),
      gate("staging-breaking-unscoped-routes", marker, "staging"),
      gate("staging-web-console-smoke", marker, "staging"),
      gate("staging-data-hygiene", marker, "staging"),
    ]);

    const result = runChecker("--manifest", manifest, "--require", "staging", "--allow-dirty", "--allow-different-git-sha");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).gatesChecked).toEqual([
      "staging-deployment",
      "staging-managed-smoke",
      "staging-stripe-checkout",
      "staging-conformance",
      "staging-usage-ledger",
      "staging-github-private-resource",
      "staging-breaking-unscoped-routes",
      "staging-web-console-smoke",
      "staging-data-hygiene",
    ]);
  });
});

function runChecker(...args: string[]): ReturnType<typeof spawnSync<string>> {
  return spawnSync("bun", [scriptPath, ...args], { encoding: "utf8" });
}

function writeManifest(dir: string, gates: unknown[]): string {
  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, JSON.stringify({
    releaseName: "test-release",
    gitSha: "4ecb7a7",
    images: {
      api: {
        image: `registry.example/opengeni-api:test@${digest}`,
        digest,
      },
      worker: {
        image: `registry.example/opengeni-worker:test@${digest}`,
        digest,
      },
      web: {
        image: `registry.example/opengeni-web:test@${digest}`,
        digest,
      },
    },
    gates,
  }));
  return manifest;
}

function productionCanaryEvidence(marker: string) {
  return {
    ok: true,
    environment: "production",
    baseUrl: "https://app.opengeni.ai",
    gitSha: "4ecb7a7",
    generatedAt: "2026-06-08T00:00:00.000Z",
    images: {
      api: {
        image: `registry.example/opengeni-api:test@${digest}`,
        digest,
      },
      worker: {
        image: `registry.example/opengeni-worker:test@${digest}`,
        digest,
      },
      web: {
        image: `registry.example/opengeni-web:test@${digest}`,
        digest,
      },
    },
    results: [
      "production-deployment",
      "production-health",
      "managed-canary-smoke",
      "production-conformance",
      "billing-readonly",
      "observability-canary",
      "rollback-readiness",
    ].map((id) => ({ id, status: "passed", evidence: [marker] })),
  };
}

function gate(id: string, evidence: string, scope = "preview") {
  return {
    id,
    status: "passed",
    requiredFor: [scope],
    evidence: [evidence],
  };
}

function previewDeploymentEvidence() {
  return {
    ok: true,
    environment: "preview-pr",
    baseUrl: "https://preview-8c27.app.opengeni.ai",
    gitSha: "4ecb7a7",
    generatedAt: "2026-06-08T00:00:00.000Z",
    images: {
      api: { image: `registry.example/opengeni-api:test@${digest}`, digest },
      worker: { image: `registry.example/opengeni-worker:test@${digest}`, digest },
      web: { image: `registry.example/opengeni-web:test@${digest}`, digest },
    },
    helm: {
      releaseName: "opengeni-preview",
      namespace: "opengeni-preview-pr",
      status: "deployed",
      valuesFiles: [
        "deploy/helm/opengeni/values.preview-managed.example.yaml",
        ".agent/generated/preview-pr/helm-values.generated.yaml",
      ],
    },
    fixtures: {
      postgres: true,
      temporal: true,
      nats: true,
      minio: true,
    },
    deployments: {
      api: { replicas: 1, readyReplicas: 1, image: `registry.example/opengeni-api:test@${digest}` },
      worker: { replicas: 1, readyReplicas: 1, image: `registry.example/opengeni-worker:test@${digest}` },
      web: { replicas: 1, readyReplicas: 1, image: `registry.example/opengeni-web:test@${digest}` },
    },
    migration: {
      completed: true,
      image: `registry.example/opengeni-api:test@${digest}`,
    },
  };
}

function stagingDeploymentEvidence() {
  return {
    ok: true,
    environment: "staging",
    baseUrl: "https://staging.app.opengeni.ai",
    gitSha: "4ecb7a7",
    generatedAt: "2026-06-08T00:00:00.000Z",
    images: {
      api: { image: `registry.example/opengeni-api:test@${digest}`, digest },
      worker: { image: `registry.example/opengeni-worker:test@${digest}`, digest },
      web: { image: `registry.example/opengeni-web:test@${digest}`, digest },
    },
    deployments: {
      api: { replicas: 2, readyReplicas: 2, image: `registry.example/opengeni-api:test@${digest}` },
      worker: { replicas: 2, readyReplicas: 2, image: `registry.example/opengeni-worker:test@${digest}` },
      web: { replicas: 2, readyReplicas: 2, image: `registry.example/opengeni-web:test@${digest}` },
    },
    privateOps: {
      workflowRunId: "27126701275",
      workflowRunUrl: "https://github.com/Cloudgeni-ai/opengeni-ops/actions/runs/27126701275",
    },
  };
}
