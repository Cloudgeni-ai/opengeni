import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("artifact runtime workflow contract", () => {
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
});
