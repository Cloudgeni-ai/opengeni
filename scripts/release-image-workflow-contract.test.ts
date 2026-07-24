import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function workflow(name: string): Promise<string> {
  return readFile(resolve(root, ".github/workflows", name), "utf8");
}

describe("release image workflow contract", () => {
  test("candidate builds every physical image and freezes a full-SHA receipt", async () => {
    const candidate = await workflow("release-candidate.yml");

    for (const identity of [
      "target: api",
      "target: worker",
      "target: web",
      "file: docker/sandbox.Dockerfile",
      "file: agent/crates/opengeni-relay/Dockerfile",
    ]) {
      expect(candidate).toContain(identity);
    }
    expect(candidate).toContain("candidate-$SOURCE_SHA");
    expect(candidate).toContain("opengeni-candidate-${SOURCE_SHA}");
    expect(candidate).toContain("evidence/release-candidate.json");
    expect(candidate).toContain("cmp evidence/release-candidate.json");
    const anonymousGate = candidate.indexOf("Verify candidate images support anonymous pull");
    const receiptWrite = candidate.indexOf("Write immutable candidate receipt");
    const receiptPublish = candidate.indexOf("Publish immutable source-SHA candidate receipt");
    expect(anonymousGate).toBeGreaterThan(-1);
    expect(anonymousGate).toBeLessThan(receiptWrite);
    expect(anonymousGate).toBeLessThan(receiptPublish);
    expect(candidate.slice(anonymousGate, receiptWrite)).toContain("docker logout ghcr.io");
    expect(candidate.slice(anonymousGate, receiptWrite)).toContain(
      "docker buildx imagetools inspect",
    );
    expect(candidate).toContain("helm package deploy/helm/opengeni");
    expect(candidate).toContain("helm push");
    expect(candidate).toContain("release-chart.sha256");
    expect(candidate).toContain("manifestDigest");
    expect(candidate).toContain("Refuse to rerun a completed immutable candidate");
    expect(candidate).toContain("use its original successful producer run ID");
    expect(candidate).toContain("existing_tag_sha");
  });

  test("final release promotes accepted manifests and has no image build boundary", async () => {
    const release = await workflow("release.yml");
    const finalJob = release.slice(release.indexOf("\n  images:\n"));

    expect(finalJob).toContain("Promote exact accepted manifests");
    expect(finalJob).toContain("docker buildx imagetools create");
    expect(finalJob).toContain("--prefer-index=false");
    expect(finalJob).toContain("evidence/release-candidate.json");
    expect(finalJob).toContain("bun scripts/release-bom.ts");
    expect(finalJob).toContain("Verify official images support anonymous pull");
    expect(finalJob).toContain("docker logout ghcr.io");
    expect(finalJob).toContain("docker buildx imagetools inspect");
    expect(release).toContain("GitHub has no supported REST API");
    expect(finalJob).not.toContain("--method PATCH");
    expect(finalJob).not.toContain("docker/build-push-action");
    expect(finalJob).not.toContain("docker build ");
    expect(finalJob).not.toContain("bake-agent.sh");
    expect(finalJob).not.toContain("helm package");
    expect(finalJob).not.toContain("helm push");
    expect(finalJob).toContain("name: production-release");
    expect(finalJob.indexOf("Compare existing immutable BOM before aliases")).toBeLessThan(
      finalJob.indexOf("Promote exact accepted manifests"),
    );
    expect(finalJob).toContain("existing_tag_sha");
    expect(release).toContain("candidate_run_id:");
    expect(release).toContain("acceptance_run_id:");
    for (const forbidden of [
      "candidate_receipt_url:",
      "candidate_receipt_sha256:",
      "acceptance_bundle_url:",
      "acceptance_bundle_sha256:",
      "staging_evidence_url:",
      "production_evidence_url:",
    ]) {
      expect(release).not.toContain(forbidden);
    }
  });

  test("acceptance is a protected canonical producer and stays fail-closed without its harness", async () => {
    const acceptance = await workflow("release-acceptance.yml");
    expect(acceptance).toContain(".github/workflows/release-acceptance.yml");
    expect(acceptance).toContain("name: production-acceptance");
    expect(acceptance).toContain("Require the operator-controlled acceptance harness");
    expect(acceptance).toContain("exit 1");
    expect(acceptance).toContain("release-acceptance-${{ inputs.source_sha }}");
  });

  test("ordinary CI builds the same five physical image roles", async () => {
    const ci = await workflow("ci.yml");
    const imagesJob = ci.slice(ci.indexOf("\n  images:\n"));

    for (const identity of [
      "target: api",
      "target: worker",
      "target: web",
      "file: docker/sandbox.Dockerfile",
      "file: agent/crates/opengeni-relay/Dockerfile",
    ]) {
      expect(imagesJob).toContain(identity);
    }
  });
});
