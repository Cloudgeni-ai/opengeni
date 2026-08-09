import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const exactCiSource =
  "${{ github.event_name == 'workflow_dispatch' && inputs.automation_head_sha || github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";

async function workflow(name: string): Promise<string> {
  return readFile(resolve(root, ".github/workflows", name), "utf8");
}

async function action(name: string): Promise<string> {
  return readFile(resolve(root, ".github/actions", name, "action.yml"), "utf8");
}

function ghApiCommands(source: string): string[] {
  const commands: string[] = [];
  let command = "";

  for (const line of source.split("\n")) {
    const start = line.search(/\bgh api\b/);
    if (!command && start >= 0) command = line.slice(start);
    else if (command) command += `\n${line}`;

    if (command && !/\\\s*$/.test(line)) {
      commands.push(command);
      command = "";
    }
  }

  if (command) commands.push(command);
  return commands;
}

describe("release image workflow contract", () => {
  test("stages Bun dependency patches before the workload image frozen install", async () => {
    const dockerfile = await readFile(resolve(root, "docker/opengeni.Dockerfile"), "utf8");
    const patchCopy = dockerfile.indexOf("COPY patches patches");
    const frozenInstall = dockerfile.indexOf("RUN bun install --frozen-lockfile");

    expect(patchCopy).toBeGreaterThan(-1);
    expect(frozenInstall).toBeGreaterThan(patchCopy);
  });

  test("dedicated artifact sidecars run self-contained production bundles", async () => {
    const [dockerfile, builder] = await Promise.all([
      readFile(resolve(root, "docker/opengeni.Dockerfile"), "utf8"),
      readFile(resolve(root, "scripts/build-runtime-processes.ts"), "utf8"),
    ]);

    for (const target of ["artifact-materializer", "artifact-outbox"]) {
      expect(builder).toContain(`"${target}"`);
      expect(dockerfile).toContain(`RUN bun scripts/build-runtime-processes.ts ${target}`);
    }
    expect(builder).toContain("splitting: false");
    expect(dockerfile).toContain(
      'CMD ["bun", "apps/worker/dist/process/artifact-materializer/artifact-materializer-entry.js"]',
    );
    expect(dockerfile).toContain(
      'CMD ["bun", "apps/worker/dist/process/artifact-outbox/artifact-outbox-entry.js"]',
    );
    expect(dockerfile).not.toContain('"start:artifact-materializer"');
    expect(dockerfile).not.toContain('"start:artifact-outbox"');
  });

  test("coalesces mutable Version-PR work without cancelling immutable publication", async () => {
    const [release, ci] = await Promise.all([workflow("release.yml"), workflow("ci.yml")]);
    const versionProjection = release.slice(
      release.indexOf("\n  version:\n"),
      release.indexOf("\n  publish:\n"),
    );

    expect(release).toContain(
      "github.event_name == 'push' && 'release-version-latest-main' || format('release-publish-{0}', inputs.source_sha)",
    );
    expect(release).toContain("cancel-in-progress: ${{ github.event_name == 'push' }}");
    expect(ci).toContain(
      "github.event_name == 'workflow_dispatch' && format('ci-automation-{0}', inputs.automation_pr_number)",
    );
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'workflow_dispatch' }}");
    expect(ci).not.toContain(
      "format('ci-automation-{0}-{1}', inputs.automation_pr_number, inputs.automation_head_sha)",
    );
    for (const duplicatedGate of [
      "scripts/ci/run-typecheck-plan.ts",
      "scripts/ci/run-build-plan.ts",
      "bun scripts/publish-closure-guard.ts",
      "bun run test:runtime-embedding-consumer",
      "bun run test:ogtool-package",
    ]) {
      expect(versionProjection).not.toContain(duplicatedGate);
      expect(ci).toContain(duplicatedGate);
    }
  });

  test("downloads artifact ZIPs through portable gh api stdout redirection", async () => {
    const workflows = await Promise.all(
      ["release-acceptance.yml", "release.yml", "release-embedded.yml"].map(workflow),
    );
    const commands = workflows.flatMap(ghApiCommands);
    expect(commands.filter((command) => command.includes("--output"))).toHaveLength(0);
    const artifactDownloads = commands.filter(
      (command) => command.includes("/actions/artifacts/") && command.includes("/zip"),
    );

    expect(artifactDownloads).toHaveLength(6);
    for (const command of artifactDownloads) {
      expect(command).toMatch(/\/zip["']?\s*\\?\s*(?:\n\s*)?>\s*[^\s]+/);
    }
  });

  test("candidate builds every physical image and freezes a full-SHA receipt", async () => {
    const candidate = await workflow("release-candidate.yml");

    expect(candidate).not.toContain("expected_packages:");
    expect(candidate).not.toContain("OPENGENI_EXPECTED_PACKAGES");
    expect(candidate).toContain('OPENGENI_RELEASE_PACKAGE_DERIVE_EXPECTED: "true"');
    for (const identity of [
      "target: api",
      "target: worker",
      "target: web",
      "target: artifact-materializer",
      "target: artifact-outbox-dispatcher",
      "file: docker/sandbox.Dockerfile",
      "file: agent/crates/opengeni-relay/Dockerfile",
    ]) {
      expect(candidate).toContain(identity);
    }
    expect(candidate).toContain("docker/setup-qemu-action@");
    expect(candidate.match(/platforms: linux\/amd64,linux\/arm64/g)).toHaveLength(7);
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
    expect(candidate.slice(anonymousGate, receiptWrite)).toContain('docker logout "$REGISTRY"');
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
    expect(candidate).toContain("bun scripts/resolve-github-release-state.ts");
    expect(candidate).toContain('git merge-base --is-ancestor "$SOURCE_SHA" origin/main');
    expect(candidate).not.toContain('[ "$(git rev-parse origin/main)" = "$SOURCE_SHA" ]');
    expect(candidate).not.toContain('gh release view "$tag"');
    expect(candidate).not.toContain('existing_tag_sha="$(gh api');
  });

  test("main CI publishes exact-SHA dogfood images without granting PR publication", async () => {
    const ci = await workflow("ci.yml");
    const images = ci.slice(ci.indexOf("\n  api-image:\n"), ci.indexOf("\n  automation-report:\n"));
    const parsed = Bun.YAML.parse(ci) as {
      jobs: Record<
        string,
        {
          name?: string;
          needs?: string | string[];
          if?: string;
          steps?: Array<{
            name?: string;
            env?: Record<string, string>;
            run?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };

    const leafNames = [
      "api-image",
      "worker-web-images",
      "artifact-materializer-image",
      "artifact-outbox-dispatcher-image",
      "relay-image",
      "sandbox-image",
    ];
    for (const jobName of [
      "worker-web-images",
      "artifact-outbox-dispatcher-image",
      "relay-image",
    ]) {
      expect(parsed.jobs[jobName]?.needs).toEqual(["automation-admission", "plan"]);
    }
    for (const jobName of ["api-image", "artifact-materializer-image", "sandbox-image"]) {
      expect(parsed.jobs[jobName]?.needs).toEqual([
        "automation-admission",
        "plan",
        "artifact-runtime",
      ]);
    }
    expect(parsed.jobs.images?.name).toBe("Workload image builds");
    expect(parsed.jobs.images?.needs).toEqual([
      "automation-admission",
      "plan",
      "api-image",
      "worker-web-images",
      "artifact-materializer-image",
      "artifact-outbox-dispatcher-image",
      "relay-image",
      "sandbox-image",
    ]);
    for (const jobName of ["api-image", "artifact-materializer-image", "sandbox-image"]) {
      expect(parsed.jobs[jobName]?.if).toBe(parsed.jobs["api-image"]?.if);
    }
    for (const jobName of [
      "worker-web-images",
      "artifact-outbox-dispatcher-image",
      "relay-image",
    ]) {
      expect(parsed.jobs[jobName]?.if).toBe(parsed.jobs["worker-web-images"]?.if);
    }
    expect(parsed.jobs.images?.if).toBe(parsed.jobs["worker-web-images"]?.if);
    expect(images.match(/packages: write/g)).toHaveLength(6);
    for (const jobName of leafNames) {
      const login = parsed.jobs[jobName]?.steps?.find((step) => step.name === "Log in to GHCR");
      expect(login?.with).toEqual({
        registry: "ghcr.io",
        username: "${{ github.actor }}",
        password: "${{ secrets.GITHUB_TOKEN }}",
      });
    }
    expect(images).toContain("Require every workload image build");
    expect(images).toContain("API_IMAGE_RESULT: ${{ needs.api-image.result }}");
    expect(images).toContain("WORKER_WEB_IMAGES_RESULT: ${{ needs.worker-web-images.result }}");
    expect(images).toContain(
      "ARTIFACT_MATERIALIZER_IMAGE_RESULT: ${{ needs.artifact-materializer-image.result }}",
    );
    expect(images).toContain(
      "ARTIFACT_OUTBOX_DISPATCHER_IMAGE_RESULT: ${{ needs.artifact-outbox-dispatcher-image.result }}",
    );
    expect(images).toContain("RELAY_IMAGE_RESULT: ${{ needs.relay-image.result }}");
    expect(images).toContain("SANDBOX_IMAGE_RESULT: ${{ needs.sandbox-image.result }}");
    const aggregate = parsed.jobs.images?.steps?.find(
      (step) => step.name === "Require every workload image build",
    );
    expect(aggregate?.env).toEqual({
      API_IMAGE_RESULT: "${{ needs.api-image.result }}",
      WORKER_WEB_IMAGES_RESULT: "${{ needs.worker-web-images.result }}",
      ARTIFACT_MATERIALIZER_IMAGE_RESULT: "${{ needs.artifact-materializer-image.result }}",
      ARTIFACT_OUTBOX_DISPATCHER_IMAGE_RESULT:
        "${{ needs.artifact-outbox-dispatcher-image.result }}",
      RELAY_IMAGE_RESULT: "${{ needs.relay-image.result }}",
      SANDBOX_IMAGE_RESULT: "${{ needs.sandbox-image.result }}",
    });
    const aggregateResult = (...results: string[]) =>
      Bun.spawnSync(["bash", "-c", aggregate?.run ?? "exit 1"], {
        env: {
          ...process.env,
          API_IMAGE_RESULT: results[0],
          WORKER_WEB_IMAGES_RESULT: results[1],
          ARTIFACT_MATERIALIZER_IMAGE_RESULT: results[2],
          ARTIFACT_OUTBOX_DISPATCHER_IMAGE_RESULT: results[3],
          RELAY_IMAGE_RESULT: results[4],
          SANDBOX_IMAGE_RESULT: results[5],
        },
      }).exitCode;
    expect(aggregateResult("success", "success", "success", "success", "success", "success")).toBe(
      0,
    );
    for (const result of ["failure", "skipped", "cancelled", ""]) {
      for (let index = 0; index < 6; index += 1) {
        const results = Array(6).fill("success") as string[];
        results[index] = result;
        expect(aggregateResult(...results)).not.toBe(0);
      }
    }
    expect(images.match(/push: \$\{\{ github\.event_name == 'push' \}\}/g)).toHaveLength(7);
    expect(images.match(/:dogfood-sha-\{0\}', github\.sha\)/g)).toHaveLength(7);
    expect(images).not.toMatch(/format\('ghcr\.io\/cloudgeni-ai\/opengeni-[^']+:sha-\{0\}'/);
    expect(images.split(`OPENGENI_SERVER_VERSION=sha-${exactCiSource}`).length - 1).toBe(5);
    expect(images).toContain(`OPENGENI_DEPLOYMENT_REVISION=${exactCiSource}`);
    expect(images).toContain("Write exact-main-SHA dogfood receipt");
    expect(images).toContain("Upload exact-main-SHA dogfood receipt");
    expect(images).toContain("API_DIGEST: ${{ needs.api-image.outputs.api_digest }}");
    expect(images).toContain("WORKER_DIGEST: ${{ needs.worker-web-images.outputs.worker_digest }}");
    expect(images).toContain("WEB_DIGEST: ${{ needs.worker-web-images.outputs.web_digest }}");
    expect(images).toContain("RELAY_DIGEST: ${{ needs.relay-image.outputs.relay_digest }}");
    expect(images).toContain("SANDBOX_DIGEST: ${{ needs.sandbox-image.outputs.sandbox_digest }}");
    expect(images).toContain(
      "ARTIFACT_MATERIALIZER_DIGEST: ${{ needs.artifact-materializer-image.outputs.artifact_materializer_digest }}",
    );
    expect(images).toContain(
      "ARTIFACT_OUTBOX_DISPATCHER_DIGEST: ${{ needs.artifact-outbox-dispatcher-image.outputs.artifact_outbox_dispatcher_digest }}",
    );
    expect(images).toContain('--arg tag "dogfood-sha-${GITHUB_SHA}"');
    expect(images).not.toContain('--arg tag "sha-${GITHUB_SHA}"');
    expect(images).toContain("dogfood-images-${{ github.sha }}");
    expect(images).toContain("dogfood-images.sha256");
    expect(images).toContain("'^sha256:[0-9a-f]{64}$'");
    expect(images).not.toMatch(/:latest(?:['"}\s]|$)/);
  });

  test("final release promotes accepted manifests and has no image build boundary", async () => {
    const release = await workflow("release.yml");
    const finalJob = release.slice(release.indexOf("\n  images:\n"));

    expect(release).not.toContain("inputs.expected_packages");
    expect(release).toContain("steps.acceptance-bundle.outputs.expected_packages");
    expect(release).toContain('map(.name + "@" + .version)');
    expect(release).toContain("map({name, version})");
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
    expect(finalJob).toContain('docker logout "$REGISTRY"');
    expect(finalJob).toContain("docker buildx imagetools inspect");
    expect(release).toContain("OPENGENI_RELEASE_OCI_PREFIX");
    expect(release).toContain("OPENGENI_RELEASE_REGISTRY_AUTH");
    expect(finalJob).not.toContain("--method PATCH");
    expect(finalJob).not.toContain("docker/build-push-action");
    expect(finalJob).not.toContain("docker build ");
    expect(finalJob).not.toContain("bake-agent.sh");
    expect(finalJob).not.toContain("helm package");
    expect(finalJob).toContain("Publish or reconcile the exact accepted Helm chart");
    expect(finalJob).toContain("helm push");
    expect(finalJob).toContain(
      'chart_ref="${OPENGENI_RELEASE_OCI_PREFIX}/charts/opengeni/opengeni:${RELEASE_VERSION}"',
    );
    expect(finalJob).toContain('chart_pull_oci="${chart_oci}/opengeni"');
    expect(finalJob).toContain('helm pull "$chart_pull_oci"');
    expect(finalJob).toContain(
      'helm pull "oci://${OPENGENI_RELEASE_OCI_PREFIX}/charts/opengeni/opengeni"',
    );
    expect(finalJob).toContain('helm push "$chart_path" "$chart_oci"');
    expect(finalJob).toContain('--arg reference "$chart_pull_oci"');
    expect(finalJob).toContain("for attempt in $(seq 1 10)");
    expect(finalJob).toContain(
      'resolved_manifest="$(bun scripts/resolve-optional-oci-manifest.ts "$chart_ref")"',
    );
    expect(finalJob).toContain("name: production-release");
    expect(finalJob.indexOf("Compare existing immutable BOM before aliases")).toBeLessThan(
      finalJob.indexOf("Promote exact accepted manifests"),
    );
    expect(finalJob).toContain("bun scripts/resolve-github-release-state.ts");
    expect(finalJob).not.toContain('gh release view "$tag"');
    expect(finalJob).not.toContain('existing_tag_sha="$(gh api');
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
    expect(acceptance).toContain('git merge-base --is-ancestor "$SOURCE_SHA" origin/main');
    expect(acceptance).not.toContain('[ "$(git rev-parse origin/main)" = "$SOURCE_SHA" ]');
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
    const packageProvenance = release.indexOf("Resolve trusted package publication provenance");
    const packagePublication = release.indexOf("Publish source-bound packages");

    expect(release).toContain("candidate_run_id:");
    expect(release).toContain("package_source_sha:");
    expect(release).toContain("package_run_id:");
    expect(release).toContain("bun .release/controller/scripts/verify-release-provenance.ts");
    expect(release).toContain("--kind package");
    expect(release).toContain("CANDIDATE_ARTIFACT_ID:");
    expect(release).toContain("CANDIDATE_ARTIFACT_DIGEST:");
    expect(release).toContain("CANDIDATE_SOURCE_TREE_SHA:");
    expect(release).toContain("PACKAGE_ARTIFACT_ID:");
    expect(release).toContain("PACKAGE_ARTIFACT_DIGEST:");
    expect(release).toContain("evidence/package-publication-verified.json");
    expect(release).toContain("evidence/package-provenance.json");
    expect(release).toContain("OPENGENI_RELEASE_PACKAGE_BOM_RECEIPT:");
    expect(release).toContain("OPENGENI_RELEASE_PACKAGE_BOM_SOURCE_SHA:");
    expect(release).toContain("OPENGENI_RELEASE_PACKAGE_CLOSURE_ROOT:");
    expect(release).toContain("bun .release/controller/scripts/verify-release-packages.ts");
    expect(release).toContain("bun scripts/release-candidate.ts");
    expect(release).toContain('if [ -n "$EXPECTED_PACKAGES" ]; then');
    expect(release).toContain('candidate_verify_args+=(--expected-packages "$EXPECTED_PACKAGES")');
    expect(release).toContain('bun scripts/release-candidate.ts "${candidate_verify_args[@]}"');
    expect(release).toContain("bun scripts/release-version.ts deploy/helm/opengeni/Chart.yaml");
    expect(release).not.toContain('map(select(.name == "@opengeni/sdk"))');
    expect(release).toContain("bun run test:runtime-embedding-consumer");
    expect(release).toContain("bun run test:publish-consumer");
    expect(release).toContain("uses: changesets/action@");
    expect(release).toContain("OPENGENI_RELEASE_PACKAGE_PHASE: verify");
    expect(release).not.toContain("OPENGENI_RELEASE_PACKAGE_DERIVE_EXPECTED");
    expect(release).toContain("Publish or reconcile the exact candidate chart");
    expect(release).toContain('[ "$GITHUB_REF" = "refs/heads/main" ]');
    expect(release).not.toContain('[ "$GITHUB_SHA" = "$SOURCE_SHA" ]');
    expect(release).toContain(
      'chart_ref="${OPENGENI_RELEASE_OCI_PREFIX}/charts/opengeni/opengeni:${RELEASE_VERSION}"',
    );
    expect(release).toContain('chart_pull_oci="${chart_oci}/opengeni"');
    expect(release).toContain('helm pull "$chart_pull_oci"');
    expect(release).toContain(
      'helm pull "oci://${OPENGENI_RELEASE_OCI_PREFIX}/charts/opengeni/opengeni"',
    );
    expect(release).toContain('helm push "$chart_path" "$chart_oci"');
    expect(release).toContain('--arg reference "$chart_pull_oci"');
    expect(release).toContain("for attempt in $(seq 1 10)");
    expect(release).toContain(
      'resolved_manifest="$(bun scripts/resolve-optional-oci-manifest.ts "$chart_ref")"',
    );
    expect(release).toContain('OPENGENI_RELEASE_BOM_CHART="$RELEASE_CHART"');
    expect(release).toContain("bun scripts/resolve-github-release-state.ts");
    expect(release).not.toContain('gh release view "$tag"');
    expect(release).toContain("bun scripts/release-bom.ts");
    expect(release).toContain("evidence/release-bom.json");
    expect(release).toContain('docker logout "$REGISTRY"');
    expect(registryReconcile).toBeGreaterThan(-1);
    expect(packageProvenance).toBeGreaterThan(-1);
    expect(packagePublication).toBeGreaterThan(packageProvenance);
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

  test("package-only publication is exact-source, CI-gated, and evidence-bound", async () => {
    const publish = await workflow("publish-packages.yml");
    const sourceGate = publish.indexOf("Require successful protected source CI");
    const plan = publish.indexOf("Plan exact package publication");
    const retainedPlan = publish.indexOf("Retain pre-publication package plan");
    const mutation = publish.indexOf("Publish unpublished package versions");
    const reconciliation = publish.indexOf("Reconcile exact registry package identity");

    expect(publish).toContain("expected_packages:");
    expect(publish).not.toContain("OPENGENI_RELEASE_PACKAGE_DERIVE_EXPECTED");
    expect(publish).toContain("checks: read");
    expect(publish).toContain("filter=latest&per_page=100");
    expect(publish).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(publish).toContain('git merge-base --is-ancestor "$SOURCE_SHA" origin/main');
    expect(publish).not.toContain('test "$(git rev-parse origin/main)" = "$SOURCE_SHA"');
    expect(publish).toContain("else max_by(.id)");
    expect(publish).toContain('.status == "completed" and .conclusion == "success"');
    expect(publish).not.toContain("| length == 1");
    for (const required of [
      "Typecheck and unit tests",
      "Deployment artifacts",
      "Workload image builds",
    ]) {
      expect(publish).toContain(required);
    }
    expect(publish).toContain("OPENGENI_RELEASE_PACKAGE_PHASE: plan");
    expect(publish).toContain("OPENGENI_RELEASE_PACKAGE_PHASE: verify");
    expect(publish).toContain("bun scripts/verify-release-packages.ts");
    expect(publish).toContain("actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10");
    expect(publish).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(publish).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
    expect(publish).not.toMatch(/actions\/(?:checkout|setup-node)@v[0-9]/);
    expect(publish).not.toMatch(/oven-sh\/setup-bun@v[0-9]/);
    expect(sourceGate).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(sourceGate);
    expect(retainedPlan).toBeGreaterThan(plan);
    expect(mutation).toBeGreaterThan(retainedPlan);
    expect(reconciliation).toBeGreaterThan(mutation);
  });

  test("public registry authentication is portable, short-lived, and version-bound", async () => {
    const candidate = await workflow("release-candidate.yml");
    const release = await workflow("release.yml");
    const embedded = await workflow("release-embedded.yml");
    const login = await action("public-oci-login");
    const loginManifest = Bun.YAML.parse(login) as {
      name?: unknown;
      runs?: { using?: unknown; steps?: unknown };
    };

    for (const source of [candidate, release, embedded]) {
      expect(source).toContain("uses: ./.github/actions/public-oci-login");
      expect(source).toContain("OPENGENI_RELEASE_OCI_PREFIX");
      expect(source).toContain("OPENGENI_RELEASE_REGISTRY_AUTH");
      expect(source).toContain("id-token: write");
    }
    expect(loginManifest.name).toBe("Public OCI registry login");
    expect(loginManifest.runs?.using).toBe("composite");
    expect(Array.isArray(loginManifest.runs?.steps)).toBe(true);
    expect(login).toContain("azure-oidc");
    expect(login).toContain("github");
    expect(login).toContain("azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43");
    expect(login).toContain("azure/cli@9eb25b8360668fb0ecbafa808d40e2197b2f5f52");
    expect(login).toContain("azcliversion: 2.88.0");
    expect(login).toContain('[ "$actual_version" = "2.88.0" ]');
    expect(login).toContain("--expose-token");
    expect(login).not.toContain("client-secret");
    expect(login).not.toContain("admin-password");
  });

  test("agent publication creates only immutable-compatible versioned releases", async () => {
    const agentRelease = await workflow("agent-release.yml");

    expect(agentRelease).toContain(
      "uses: softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65",
    );
    expect(agentRelease).not.toContain("softprops/action-gh-release@v2");
    expect(agentRelease).toContain("tag_name: agent-v${{ needs.guard.outputs.version }}");
    expect(agentRelease).toContain("OPENGENI_AGENT_STABLE_VERSION");
    expect(agentRelease).toContain("Build and sign the stable update manifest");
    expect(agentRelease).toContain("dist/manifest.json.minisig");
    expect(agentRelease).toContain("rollout_percent 100");
    expect(agentRelease).toContain("Require the release signing key");
    expect(agentRelease).toContain('NOTARY_ARCHIVE="${{ matrix.asset }}.notary.zip"');
    expect(agentRelease).toContain(
      'ditto -c -k --keepParent "${{ matrix.asset }}" "$NOTARY_ARCHIVE"',
    );
    expect(agentRelease).toContain(
      'rcodesign notary-submit --api-key-path /tmp/asc.json --wait "$NOTARY_ARCHIVE"',
    );
    expect(agentRelease).not.toContain(
      'rcodesign notary-submit --api-key-path /tmp/asc.json --wait "${{ matrix.asset }}"',
    );
    expect(agentRelease).not.toContain("manifest publish is wired via");
    expect(agentRelease).not.toContain("gh release delete");
    expect(agentRelease).not.toContain("gh release create agent-latest");
    expect(agentRelease).not.toContain("releases/download/agent-latest");
  });

  test("release-state parsing accepts a valid absent release without weakening type checks", async () => {
    const candidate = await workflow("release-candidate.yml");
    const release = await workflow("release.yml");
    const embedded = await workflow("release-embedded.yml");
    const parser =
      `release_exists="$(jq -er '.releaseExists | if type == "boolean" ` +
      `then tostring else error("releaseExists must be boolean") end' <<<"$state")"`;

    expect(candidate.match(/release_exists=/g)).toHaveLength(2);
    expect(release.match(/release_exists=/g)).toHaveLength(2);
    expect(embedded.match(/release_exists=/g)).toHaveLength(1);
    for (const source of [candidate, release, embedded]) {
      expect(source).toContain(parser);
      expect(source).not.toContain("jq -er .releaseExists");
    }

    const falseResult = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
state='{"releaseExists":false}'
${parser}
test "$release_exists" = "false"`,
      ],
      { encoding: "utf8" },
    );
    expect(falseResult.status, falseResult.stderr).toBe(0);

    const invalidResult = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
state='{"releaseExists":"false"}'
${parser}`,
      ],
      { encoding: "utf8" },
    );
    expect(invalidResult.status).not.toBe(0);
  });

  test("ordinary CI builds the same seven physical image roles", async () => {
    const ci = await workflow("ci.yml");
    const parsed = Bun.YAML.parse(ci) as { jobs: Record<string, { steps: Array<unknown> }> };
    const imagesJob = ci.slice(ci.indexOf("\n  api-image:\n"));

    for (const identity of [
      "target: api",
      "target: worker",
      "target: web",
      "target: artifact-materializer",
      "target: artifact-outbox-dispatcher",
      "file: docker/sandbox.Dockerfile",
      "file: agent/crates/opengeni-relay/Dockerfile",
    ]) {
      expect(imagesJob).toContain(identity);
    }
    expect(imagesJob).toContain("docker/setup-qemu-action@");
    expect(imagesJob.match(/platforms: linux\/amd64,linux\/arm64/g)).toHaveLength(7);

    const imageSteps = [
      "api-image",
      "worker-web-images",
      "artifact-materializer-image",
      "artifact-outbox-dispatcher-image",
      "relay-image",
      "sandbox-image",
    ].flatMap((jobName) =>
      parsed.jobs[jobName]!.steps.filter(
        (step): step is { name: string; uses: string; with: Record<string, string> } =>
          typeof step === "object" &&
          step !== null &&
          "uses" in step &&
          step.uses === "docker/build-push-action@v7.3.0",
      ).map((step) => ({
        jobName,
        name: step.name,
        step,
        fingerprint: createHash("sha256").update(JSON.stringify(step)).digest("hex"),
      })),
    );
    expect(imageSteps.map(({ step: _step, ...identity }) => identity)).toEqual([
      {
        jobName: "api-image",
        name: "Build API image",
        fingerprint: "791b6b1d1ea3bbb12a893b2056b2db1c343c2972f6202fe1be6276eed30f66f1",
      },
      {
        jobName: "worker-web-images",
        name: "Build worker image",
        fingerprint: "18b96f7cc2e97584967f580b6e678f20c96022ca77db76fea49753df8e82641a",
      },
      {
        jobName: "worker-web-images",
        name: "Build web image",
        fingerprint: "1689497eac266bd4b700ddea4e1f4d7ced2316657a2be37062d6ee064bf2d8e8",
      },
      {
        jobName: "artifact-materializer-image",
        name: "Build artifact materializer image",
        fingerprint: "932536d47211c1a8b5e77d2d5eda9aed64df87f6d3297f29c2a0a2f86c84528d",
      },
      {
        jobName: "artifact-outbox-dispatcher-image",
        name: "Build artifact outbox dispatcher image",
        fingerprint: "ea59c9c57d6e0ccc97b05d34d9f13c2cd7531faf791d00cb248a893a0bb77635",
      },
      {
        jobName: "relay-image",
        name: "Build relay image",
        fingerprint: "1464aec087ebbbd792371ceb86f67c41ecd75ba500b824a784ed94affb8e6a9f",
      },
      {
        jobName: "sandbox-image",
        name: "Build headless sandbox image",
        fingerprint: "a336e75d1ba14e166a4ae30a53d0a6aa4a4bec663f4b14ec2b2607015d1cd6c1",
      },
    ]);

    const expectedCacheScopes = new Map([
      ["Build API image", "opengeni-ci-api"],
      ["Build worker image", "opengeni-ci-worker"],
      ["Build artifact materializer image", "opengeni-ci-artifact-materializer"],
      ["Build artifact outbox dispatcher image", "opengeni-ci-artifact-outbox-dispatcher"],
      ["Build web image", "opengeni-ci-web"],
      ["Build relay image", "opengeni-ci-relay"],
      ["Build headless sandbox image", "opengeni-ci-sandbox"],
    ]);
    const hasCompleteCacheContract = (
      steps: Array<{ name: string; step: { with: Record<string, string> } }>,
    ) =>
      steps.every(({ name, step }) => {
        const scope = expectedCacheScopes.get(name);
        return (
          scope !== undefined &&
          step.with["cache-from"] === `type=gha,scope=${scope}` &&
          step.with["cache-to"] ===
            `\${{ github.event_name == 'push' && 'type=gha,mode=min,scope=${scope},ignore-error=true' || '' }}`
        );
      });

    expect(hasCompleteCacheContract(imageSteps)).toBe(true);
    const missingExporter = structuredClone(imageSteps);
    delete missingExporter[0]!.step.with["cache-to"];
    expect(hasCompleteCacheContract(missingExporter)).toBe(false);
    const unconditionalPullRequestExporter = structuredClone(imageSteps);
    unconditionalPullRequestExporter[0]!.step.with["cache-to"] =
      "type=gha,mode=min,scope=opengeni-ci-api,ignore-error=true";
    expect(hasCompleteCacheContract(unconditionalPullRequestExporter)).toBe(false);
  });
});
