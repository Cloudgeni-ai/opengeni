import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

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
  test("downloads artifact ZIPs through portable gh api stdout redirection", async () => {
    const workflows = await Promise.all(
      ["release-acceptance.yml", "release.yml", "release-embedded.yml"].map(workflow),
    );
    const commands = workflows.flatMap(ghApiCommands);
    expect(commands.filter((command) => command.includes("--output"))).toHaveLength(0);
    const artifactDownloads = commands.filter(
      (command) => command.includes("/actions/artifacts/") && command.includes("/zip"),
    );

    expect(artifactDownloads).toHaveLength(5);
    for (const command of artifactDownloads) {
      expect(command).toMatch(/\/zip["']?\s*\\?\s*(?:\n\s*)?>\s*[^\s]+/);
    }
  });

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
    expect(candidate).toContain("docker/setup-qemu-action@");
    expect(candidate.match(/platforms: linux\/amd64,linux\/arm64/g)).toHaveLength(5);
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
    expect(candidate).not.toContain('gh release view "$tag"');
    expect(candidate).not.toContain('existing_tag_sha="$(gh api');
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
    expect(publish).toContain("checks: read");
    expect(publish).toContain("filter=latest&per_page=100");
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
    expect(imagesJob).toContain("docker/setup-qemu-action@");
    expect(imagesJob.match(/platforms: linux\/amd64,linux\/arm64/g)).toHaveLength(5);
  });
});
