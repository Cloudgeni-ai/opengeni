import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const source = readFileSync(
  new URL("../.github/workflows/publish-desktop-image.yml", import.meta.url),
  "utf8",
);
const workflow = Bun.YAML.parse(source);
const job = workflow.jobs["desktop-image"];
const steps = job.steps;

test("desktop publication uses existing public-release OIDC without global OCI routing", () => {
  expect(job.environment).toBe("public-release");
  expect(job.permissions).toEqual({ contents: "read", packages: "write", "id-token": "write" });
  const login = steps.find((step: any) => step.uses === "./.github/actions/public-oci-login");
  expect(login.with).toEqual({
    "oci-prefix": "opengenipublicneuacr.azurecr.io",
    auth: "azure-oidc",
    "azure-client-id": "${{ vars.AZURE_CLIENT_ID }}",
    "azure-tenant-id": "${{ vars.AZURE_TENANT_ID }}",
    "azure-subscription-id": "${{ vars.AZURE_SUBSCRIPTION_ID }}",
  });
  for (const name of ["Set up Bun", "Set up Helm"]) {
    expect(steps.findIndex((step: any) => step.name === name)).toBeLessThan(steps.indexOf(login));
  }
  expect(steps[0].with.ref).toBe("${{ github.sha }}");
  expect(steps.find((step: any) => step.id === "desktop_image").with.tags).toBe(
    "opengenipublicneuacr.azurecr.io/opengeni-desktop:preview-${{ github.sha }}",
  );
});

test("anonymous digest and installed runtime proof gates success and retains evidence", () => {
  const proof = steps.find(
    (step: any) => step.name === "Verify anonymous desktop publication and installed runtime",
  );
  expect(proof["continue-on-error"]).toBeUndefined();
  expect(proof.env.DIGEST).toBe("${{ steps.desktop_image.outputs.digest }}");
  for (const text of [
    "set -euo pipefail",
    '[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
    "docker logout opengenipublicneuacr.azurecr.io",
    "helm registry logout opengenipublicneuacr.azurecr.io",
    'export DOCKER_CONFIG="$(mktemp -d)"',
    '[ "$resolved" = "$DIGEST" ]',
    'docker pull "$image@$DIGEST"',
    '[ "$revision" = "$SOURCE_SHA" ]',
    "docker run --rm --entrypoint /bin/bash",
    "--env OPENGENI_ARTIFACT_RUNTIME_MANIFEST=/opt/opengeni/artifact-runtime/installation.json",
    "--env OPENGENI_ARTIFACT_TOOL_ENTRY=/opt/opengeni/artifact-runtime/skill-facade-entry.mjs",
    "test ! -e /opt/opengeni/artifact-runtime/.unavailable",
    "opengeni-artifact-runtime doctor --json",
  ])
    expect(proof.run).toContain(text);
  expect(proof.run.indexOf("docker logout")).toBeLessThan(proof.run.indexOf("docker pull"));
  const evidence = steps.find((step: any) => step.name === "Retain desktop publication evidence");
  expect(evidence.if).toBe("always()");
  expect(evidence.with.path).toBe(".release/desktop-publication");
});

test("published doctor receives both required installation paths in its container", () => {
  const proof = steps.find(
    (step: any) => step.name === "Verify anonymous desktop publication and installed runtime",
  );
  const command = proof.run.slice(
    proof.run.indexOf("docker run --rm"),
    proof.run.indexOf(" | tee .release/desktop-publication/runtime-doctor.json"),
  );
  const harness = `
set -euo pipefail
image=fixture
DIGEST=sha256:fixture
docker() {
  local -a container_env=()
  while (( $# )); do
    case "$1" in
      --env) container_env+=("$2"); shift 2 ;;
      --entrypoint) shift 2 ;;
      fixture@*) break ;;
      *) shift ;;
    esac
  done
  env -i "\${container_env[@]}" /bin/bash -euo pipefail -c '
    test "$OPENGENI_ARTIFACT_RUNTIME_MANIFEST" = /opt/opengeni/artifact-runtime/installation.json
    test "$OPENGENI_ARTIFACT_TOOL_ENTRY" = /opt/opengeni/artifact-runtime/skill-facade-entry.mjs
  '
}
`;
  const run = (body: string) => spawnSync("bash", ["-c", harness + body], { encoding: "utf8" });
  const valid = run(command);
  expect(valid.status).toBe(0);
  expect(valid.stderr).toBe("");
  for (const name of ["OPENGENI_ARTIFACT_RUNTIME_MANIFEST", "OPENGENI_ARTIFACT_TOOL_ENTRY"]) {
    const broken = run(command.replace(new RegExp(`--env ${name}=\\S+`), ""));
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toContain(name);
  }
});

test("legacy GHCR tags are only a non-gating mirror after ACR verification", () => {
  const mirror = steps.find(
    (step: any) => step.name === "Mirror desktop image to GHCR (best effort)",
  );
  expect(mirror["continue-on-error"]).toBe(true);
  expect(mirror.if).toBeUndefined(); // default success(): never mirror failed proof
  expect(steps.indexOf(mirror)).toBeGreaterThan(
    steps.findIndex(
      (step: any) => step.name === "Verify anonymous desktop publication and installed runtime",
    ),
  );
  expect(mirror.run).toContain('"sha-$SOURCE_SHA" "canary-sha-$SOURCE_SHA"');
  expect(mirror.run).toContain("opengenipublicneuacr.azurecr.io/opengeni-desktop@$DIGEST");
  expect(mirror.run).not.toContain("docker build");
});
