import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./check-preview-deployment-evidence.ts", import.meta.url).pathname;
const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

describe("preview deployment evidence checker", () => {
  it("passes strict preview deployment evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-preview-deploy-"));
    const evidence = writeEvidence(dir, {});

    const result = runChecker("--evidence", evidence, "--expected-git-sha", "9557a39");

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.results.map((entry: { id: string }) => entry.id)).toEqual([
      "top-level-evidence",
      "preview-helm-profile",
      "preview-fixtures",
      "preview-workloads",
      "preview-migration",
    ]);
  });

  it("fails when the preview-managed values file was omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-preview-deploy-"));
    const evidence = writeEvidence(dir, { valuesFiles: [".agent/generated/preview-pr/helm-values.generated.yaml"] });

    const result = runChecker("--evidence", evidence);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout).results.find((entry: { id: string }) => entry.id === "preview-helm-profile").detail)
      .toContain("values.preview-managed.example.yaml");
  });

  it("fails when disposable preview fixtures are not enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-preview-deploy-"));
    const evidence = writeEvidence(dir, { fixtures: { postgres: true, temporal: false, nats: true, minio: true } });

    const result = runChecker("--evidence", evidence);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout).results.find((entry: { id: string }) => entry.id === "preview-fixtures").detail)
      .toContain("temporal");
  });
});

function runChecker(...args: string[]): ReturnType<typeof spawnSync<string>> {
  return spawnSync("bun", [scriptPath, ...args], { encoding: "utf8" });
}

function writeEvidence(
  dir: string,
  options: {
    valuesFiles?: string[];
    fixtures?: Record<string, boolean>;
  },
): string {
  const evidence = join(dir, "preview-deployment.json");
  const image = `registry.example/opengeni-api:test@${digest}`;
  writeFileSync(evidence, JSON.stringify({
    ok: true,
    environment: "preview-pr",
    baseUrl: "https://preview-8c27.app.opengeni.ai",
    gitSha: "9557a39",
    generatedAt: "2026-06-08T00:00:00.000Z",
    images: {
      api: { image, digest },
      worker: { image: `registry.example/opengeni-worker:test@${digest}`, digest },
      web: { image: `registry.example/opengeni-web:test@${digest}`, digest },
    },
    helm: {
      releaseName: "opengeni-preview",
      namespace: "opengeni-preview-pr",
      status: "deployed",
      revision: 4,
      valuesFiles: options.valuesFiles ?? [
        "deploy/helm/opengeni/values.preview-managed.example.yaml",
        ".agent/generated/preview-pr/helm-values.generated.yaml",
      ],
    },
    fixtures: options.fixtures ?? {
      postgres: true,
      temporal: true,
      nats: true,
      minio: true,
    },
    deployments: {
      api: { replicas: 1, readyReplicas: 1, image },
      worker: { replicas: 1, readyReplicas: 1, image: `registry.example/opengeni-worker:test@${digest}` },
      web: { replicas: 1, readyReplicas: 1, image: `registry.example/opengeni-web:test@${digest}` },
    },
    migration: {
      completed: true,
      image,
    },
  }));
  return evidence;
}
