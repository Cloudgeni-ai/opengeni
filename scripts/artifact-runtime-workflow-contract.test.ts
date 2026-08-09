import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const exactCiSource =
  "${{ github.event_name == 'workflow_dispatch' && inputs.automation_head_sha || github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";

type CiStep = Readonly<{
  id?: string;
  name?: string;
  uses?: string;
  with?: Readonly<Record<string, unknown>>;
}>;

type CiJob = Readonly<{
  steps?: readonly CiStep[];
  with?: Readonly<Record<string, unknown>>;
}>;

describe("artifact runtime workflow contract", () => {
  test("keeps byte-hashed kernel sources identical on every checkout platform", async () => {
    const attributes = await readFile(resolve(root, ".gitattributes"), "utf8");
    expect(attributes.split(/\r?\n/u)).toContain(
      "packages/artifact-tool/kernel/** text=auto eol=lf",
    );
  });

  test("keeps Cargo output outside the read-only canonical source mount", async () => {
    const [wrapper, build] = await Promise.all([
      readFile(resolve(root, "scripts/rebuild-artifact-kernel-wasm-packages.ts"), "utf8"),
      readFile(
        resolve(root, "packages/artifact-tool/kernel/bindings/wasm/scripts/build.sh"),
        "utf8",
      ),
    ]);
    expect(wrapper).toContain('const canonicalTarget = "/tmp/opengeni-artifact-wasm-target-v1"');
    expect(wrapper).toContain("`CARGO_TARGET_DIR=${canonicalTarget}`");
    expect(build).toContain('cargo_target_dir=${CARGO_TARGET_DIR:-"$crate_dir/target"}');
    expect(build).toContain(
      'wasm_path="$cargo_target_dir/wasm32-unknown-unknown/release/opengeni_artifact_kernel_wasm.wasm"',
    );
  });

  test("aggregates only eight OS-smoked targets and proves both OCI architectures", async () => {
    const source = await readFile(resolve(root, ".github/workflows/artifact-runtime.yml"), "utf8");
    const parsed = Bun.YAML.parse(source) as {
      permissions: Record<string, string>;
      jobs: Record<string, { needs?: string[]; strategy?: { failFast?: boolean } }>;
    };

    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(source).not.toContain("secrets.");
    expect(source).not.toContain("pull_request_target");
    expect(source.match(/target: (?:darwin|linux|win32)-[a-z0-9-]+$/gmu)).toHaveLength(7);
    expect(source).toContain("bun scripts/build-artifact-runtime-target.ts --target wasm-web");
    expect(source).toContain('--target "$TARGET" --output /output/runtime');
    expect(source).toContain("path: ${{ runner.temp }}/artifact-runtime-assets/runtime");
    expect(source).toContain('artifact-kernel-build-receipt.json -type f | wc -l)" -eq 8');
    expect(source).toContain("--target all");
    expect(source).toContain("--platform linux/amd64,linux/arm64");
    expect(source).toContain("--target artifact-runtime-base");
    expect(source).toContain("runtime-cli-entry.ts doctor --json");
    expect(source).toContain("retention-days: 3");
    expect(source).toContain("include-hidden-files: true");
    expect(parsed.jobs.aggregate?.needs).toEqual(["native", "musl", "wasm"]);
  });

  test("CI and immutable candidate consume only the run-local verified bundle", async () => {
    const [ci, candidate] = await Promise.all([
      readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(root, ".github/workflows/release-candidate.yml"), "utf8"),
    ]);
    for (const source of [ci, candidate]) {
      expect(source).toContain("uses: ./.github/workflows/artifact-runtime.yml");
      expect(source).toContain("needs.artifact-runtime.outputs.artifact_name");
      expect(source).toContain("path: .release/artifact-runtime");
    }
    expect(candidate).toContain("cancel-in-progress: false");
    expect(ci).toContain("github.event_name != 'workflow_dispatch'");
    expect(ci).toContain("playwright install --with-deps chromium firefox webkit");
    for (const suite of [
      "artifact-spreadsheet-canvas.browser.e2e.ts",
      "artifact-spreadsheet-scroll.browser.e2e.ts",
      "artifact-static-renderer.browser.e2e.ts",
      "editable-artifacts.browser.e2e.ts",
    ]) {
      expect(ci).toContain(suite);
    }
  });

  test("pins PR runtime production and every runtime consumer to the exact head", async () => {
    const source = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const parsed = Bun.YAML.parse(source) as { jobs: Record<string, CiJob> };

    expect(parsed.jobs["artifact-runtime"]?.with?.source_sha).toBe(exactCiSource);

    const runtimeConsumers = [
      parsed.jobs["api-image"],
      parsed.jobs["artifact-materializer-image"],
      parsed.jobs["sandbox-image"],
    ];
    for (const job of runtimeConsumers) {
      expect(job?.steps?.find((step) => step.name === "Check out repository")?.with?.ref).toBe(
        exactCiSource,
      );
      expect(
        job?.steps?.find((step) => step.name === "Download exact artifact runtime inputs")?.with
          ?.name,
      ).toBe("${{ needs.artifact-runtime.outputs.artifact_name }}");
    }

    const serverBuilds = [
      "api-image",
      "worker-image",
      "web-image",
      "artifact-materializer-image",
      "artifact-outbox-dispatcher-image",
    ].map((jobName) =>
      parsed.jobs[jobName]?.steps?.find((step) => step.uses === "docker/build-push-action@v7.3.0"),
    );
    expect(serverBuilds.map((step) => step?.id)).toEqual([
      "api_image",
      "worker_image",
      "web_image",
      "artifact_materializer_image",
      "artifact_outbox_dispatcher_image",
    ]);
    for (const step of serverBuilds) {
      const buildArgs = step?.with?.["build-args"];
      expect(typeof buildArgs).toBe("string");
      expect(buildArgs).toContain(`OPENGENI_SERVER_VERSION=sha-${exactCiSource}`);
    }
    expect(serverBuilds.find((step) => step?.id === "web_image")?.with?.["build-args"]).toContain(
      `OPENGENI_DEPLOYMENT_REVISION=${exactCiSource}`,
    );

    const sandboxBuild = parsed.jobs["sandbox-image"]?.steps?.find(
      (step) => step.id === "sandbox_image",
    );
    expect(sandboxBuild?.with?.["build-args"]).toBe(`OPENGENI_SOURCE_SHA=${exactCiSource}`);
  });
});
