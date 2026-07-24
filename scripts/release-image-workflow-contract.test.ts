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
    expect(candidate).toContain("bun scripts/package-release-chart.ts");
    expect(candidate).toContain("bun scripts/release-version.ts deploy/helm/opengeni/Chart.yaml");
    expect(candidate).not.toContain('map(select(.name == "@opengeni/sdk"))');
    expect(candidate).toContain("Refuse an occupied product release version");
    expect(candidate.match(/bun scripts\/package-release-chart\.ts/g)).toHaveLength(2);
    expect(candidate).not.toContain("helm push");
    expect(candidate).toContain("release-chart.sha256");
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
    expect(finalJob).toContain("release_version=\"$(jq -er '.releaseVersion'");
    expect(finalJob).toContain(
      'source_release_version="$(bun scripts/release-version.ts deploy/helm/opengeni/Chart.yaml)"',
    );
    expect(finalJob).not.toContain("PUBLISHED_PACKAGES:");
    expect(finalJob).toContain("Reconcile existing product image aliases before mutation");
    expect(
      finalJob.indexOf("Reconcile existing product image aliases before mutation"),
    ).toBeLessThan(finalJob.indexOf("Publish or reconcile the exact accepted Helm chart"));
    expect(finalJob).toContain("Verify official images support anonymous pull");
    expect(finalJob).toContain("docker logout ghcr.io");
    expect(finalJob).toContain("docker buildx imagetools inspect");
    expect(release).toContain("GitHub has no supported REST API");
    expect(finalJob).not.toContain("--method PATCH");
    expect(finalJob).not.toContain("docker/build-push-action");
    expect(finalJob).not.toContain("docker build ");
    expect(finalJob).not.toContain("bake-agent.sh");
    expect(finalJob).not.toContain("helm package");
    expect(finalJob).toContain("Publish or reconcile the exact accepted Helm chart");
    expect(finalJob).toContain("helm push");
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

  test("acceptance imports only an exact protected operator artifact", async () => {
    const acceptance = await workflow("release-acceptance.yml");
    expect(acceptance).toContain(".github/workflows/release-acceptance.yml");
    expect(acceptance).toContain("name: production-acceptance");
    expect(acceptance).toContain("operator_run_id:");
    expect(acceptance).toContain("RELEASE_ACCEPTANCE_OPERATOR_REPOSITORY");
    expect(acceptance).toContain("RELEASE_ACCEPTANCE_OPERATOR_WORKFLOW_PATH");
    expect(acceptance).toContain("RELEASE_ACCEPTANCE_OPERATOR_TOKEN");
    expect(acceptance).toContain("verify-operator-acceptance-provenance.ts");
    expect(acceptance).toContain("assemble-release-acceptance.ts");
    expect(acceptance).toContain("OPERATOR_ARTIFACT_DIGEST#sha256:");
    expect(acceptance).not.toContain("operator_artifact_url:");
    expect(acceptance).not.toContain("operator_artifact_sha256:");
    expect(acceptance).toContain("release-acceptance-${{ inputs.source_sha }}");
    expect(acceptance).toContain('"workbench-acceptance.json"');
    expect(acceptance).not.toContain('"evidence/workbench-acceptance.json"');
    const release = await workflow("release.yml");
    expect(release).toContain(".release/acceptance-artifact/files/workbench-acceptance.json");
    expect(release).not.toContain(
      ".release/acceptance-artifact/files/evidence/workbench-acceptance.json",
    );
  });

  test("embedded release publishes only a verified candidate without hosted acceptance claims", async () => {
    const release = await workflow("release-embedded.yml");
    const registryReconcile = release.indexOf("Reconcile npm package identity");
    const existingReleasePreflight = release.indexOf(
      "Compare an existing immutable distribution before image mutation",
    );
    const imagePromotion = release.indexOf("Promote exact candidate manifests");

    expect(release).toContain("candidate_run_id:");
    expect(release).toContain("bun scripts/verify-release-provenance.ts");
    expect(release).toContain("CANDIDATE_ARTIFACT_ID:");
    expect(release).toContain("CANDIDATE_ARTIFACT_DIGEST:");
    expect(release).toContain("CANDIDATE_SOURCE_TREE_SHA:");
    expect(release).toContain("bun scripts/release-candidate.ts");
    expect(release).toContain("bun scripts/release-version.ts deploy/helm/opengeni/Chart.yaml");
    expect(release).not.toContain('map(select(.name == "@opengeni/sdk"))');
    expect(release).toContain("bun run test:runtime-embedding-consumer");
    expect(release).toContain("bun run test:publish-consumer");
    expect(release).toContain("uses: changesets/action@");
    expect(release).toContain("OPENGENI_RELEASE_PACKAGE_PHASE: verify");
    expect(release).toContain("Publish or reconcile the exact candidate chart");
    expect(release).toContain('OPENGENI_RELEASE_BOM_CHART="$RELEASE_CHART"');
    expect(release).toContain("bun scripts/release-bom.ts");
    expect(release).toContain("evidence/release-bom.json");
    expect(release).toContain("docker logout ghcr.io");
    expect(registryReconcile).toBeGreaterThan(-1);
    expect(existingReleasePreflight).toBeGreaterThan(registryReconcile);
    expect(imagePromotion).toBeGreaterThan(registryReconcile);
    expect(imagePromotion).toBeGreaterThan(existingReleasePreflight);
    expect(release.slice(0, imagePromotion)).toContain(
      "Reconcile existing distribution aliases before publication",
    );
    expect(release.slice(0, imagePromotion)).toContain(
      "Reconcile an existing distribution chart before publication",
    );
    expect(release.slice(imagePromotion)).toContain('--tag "${name}:${RELEASE_VERSION}"');
    expect(release.slice(imagePromotion)).toContain('--tag "${name}:sha-${SOURCE_SHA}"');
    expect(release.slice(imagePromotion)).not.toContain('--tag "${name}:latest"');
    expect(release).not.toContain("candidate_receipt_url:");
    expect(release).not.toContain("candidate_receipt_sha256:");
    expect(release).not.toContain("staging_evidence_url");
    expect(release).not.toContain("production_canary_evidence_url");
    expect(release).not.toContain("docker/build-push-action");
    expect(release).not.toContain("docker build ");
    expect(release).not.toContain('--tag "${name}:latest"');
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
