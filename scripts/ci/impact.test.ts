import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  assertRootTestDependencyMapComplete,
  createImpactPlan,
  impactPlanConsoleSummary,
  parseGitNameStatus,
} from "./impact";
import { explicitBunTestPath } from "./run-test-shard";
import { sanitizedTestEnvironment } from "./run-unit-shard";
import {
  assertTestTierMapComplete,
  deterministicFileBatches,
  deterministicShards,
  discoverTestFiles,
  fileUsesProcessGlobalTestState,
  integrationShardWeights,
  OPT_IN_TESTS,
  typecheckProjects,
  usesBrowserRunner,
} from "./workspace";

const ARTIFACT_BROWSER_E2E = [
  "test/e2e/artifact-spreadsheet-canvas.browser.e2e.ts",
  "test/e2e/artifact-spreadsheet-scroll.browser.e2e.ts",
  "test/e2e/editable-artifacts.browser.e2e.ts",
] as const;

describe("fail-closed change impact", () => {
  test("documentation-only changes retain every non-runtime public guard", () => {
    const plan = createImpactPlan(["docs/artifact-engine.md", "README.md"]);
    expect(plan.mode).toBe("docs");
    expect(plan.typecheckProjects).toEqual([]);
    expect(plan.unitTests).toEqual([]);
    expect(plan.integrationTests).toEqual([]);
    expect(plan.e2eTests).toEqual([]);
    expect(plan.buildPackages).toEqual([]);
    expect(plan.guards).toEqual(["format", "docs-refs", "generated-fonts", "public-hygiene"]);
  });

  test.each([
    "bun.lock",
    ".bun-version",
    ".github/workflows/ci.yml",
    ".dockerignore",
    "scripts/ci/workspace.ts",
    "scripts/release-publish.sh",
    "packages/db/drizzle/0042_example.sql",
    "packages/agent-proto/src/gen/opengeni_agent.ts",
    "unknown/new-root.ts",
    "test/integration/new-unmapped.integration.ts",
  ])("%s activates the full safety net", (path) => {
    const plan = createImpactPlan([path]);
    expect(plan.mode).toBe("full");
    expect(plan.unitTests.length).toBeGreaterThan(100);
    expect(plan.typecheckProjects).toEqual(typecheckProjects());
    expect(plan.guards).toContain("public-hygiene");
    expect(plan.reasons.some((reason) => reason.path === path)).toBe(true);
  });

  test("empty and invalid change sets fail closed", () => {
    for (const changed of [[], ["../outside.ts"], ["/absolute.ts"], ["bad\\path.ts"]]) {
      expect(createImpactPlan(changed).mode).toBe("full");
    }
  }, 30_000);

  test("a package change selects the package, reverse dependents, and linked outputs", () => {
    const sdk = createImpactPlan(["packages/sdk/src/client.ts"]);
    expect(sdk.mode).toBe("focused");
    expect(sdk.affectedPackages).toEqual(
      expect.arrayContaining(["@opengeni/sdk", "@opengeni/react", "opengeni-web"]),
    );
    expect(sdk.typecheckProjects).toContain("packages/sdk");
    expect(sdk.unitTests).toContain("packages/sdk/test/client.test.ts");
    expect(sdk.e2eTests).toEqual([
      "test/e2e/artifact-spreadsheet-canvas.browser.e2e.ts",
      "test/e2e/artifact-spreadsheet-scroll.browser.e2e.ts",
      "test/e2e/code-editor.browser.e2e.ts",
      "test/e2e/composer-responsive.browser.e2e.ts",
      "test/e2e/connected-machine-removal.browser.e2e.ts",
      "test/e2e/editable-artifacts.browser.e2e.ts",
      "test/e2e/react-compiled-css.browser.e2e.ts",
    ]);
    expect(sdk.buildPackages).toEqual(expect.arrayContaining(["@opengeni/sdk", "@opengeni/react"]));

    const react = createImpactPlan(["packages/react/src/index.ts"]);
    expect(react.buildPackages).toEqual(
      expect.arrayContaining(["@opengeni/sdk", "@opengeni/react"]),
    );
  });

  test("artifact kernel, native, and runtime sources select package and expensive runtime gates", () => {
    const plan = createImpactPlan([
      "packages/artifact-tool/kernel/src/lib.rs",
      "packages/artifact-tool/src/native.ts",
      "packages/artifact-tool/src/runtime.ts",
    ]);
    expect(plan.mode).toBe("focused");
    expect(plan.affectedPackages).toEqual(
      expect.arrayContaining(["@opengeni/artifact-tool", "@opengeni/react", "opengeni-web"]),
    );
    expect(plan.typecheckProjects).toContain("packages/artifact-tool");
    expect(plan.unitTests).toEqual(
      expect.arrayContaining([
        "packages/artifact-tool/test/kernel.test.ts",
        "packages/artifact-tool/test/native.test.ts",
        "packages/artifact-tool/test/runtime.test.ts",
      ]),
    );
    expect(plan.integrationTests).toContain("test/integration/api.integration.ts");
    expect(plan.e2eTests).toEqual(expect.arrayContaining([...ARTIFACT_BROWSER_E2E]));
    expect(plan.buildPackages).toEqual(
      expect.arrayContaining(["@opengeni/artifact-tool", "@opengeni/react", "@opengeni/sdk"]),
    );
    // Browser acceptance, artifact-runtime production, and image builds all use non-doc mode.
    expect(plan.mode).not.toBe("docs");
  });

  test("artifact runtime scripts and canonical skills stay focused without skipping consumers", () => {
    const runtime = createImpactPlan(["scripts/build-artifact-runtime-target.ts"]);
    expect(runtime.mode).toBe("focused");
    expect(runtime.affectedPackages).toEqual(
      expect.arrayContaining([
        "@opengeni/api-router",
        "@opengeni/artifact-kernel-wasm-document",
        "@opengeni/artifact-kernel-wasm-presentation",
        "@opengeni/artifact-kernel-wasm-spreadsheet",
        "@opengeni/artifact-tool",
        "@opengeni/react",
        "@opengeni/runtime",
        "@opengeni/sdk",
        "@opengeni/worker-bundle",
      ]),
    );
    expect(runtime.unitTests).toEqual(
      expect.arrayContaining([
        "scripts/artifact-runtime-workflow-contract.test.ts",
        "scripts/build-artifact-kernel-wasm-packages.test.ts",
        "scripts/build-artifact-runtime-target.test.ts",
        "scripts/prepare-development-artifact-runtime.test.ts",
      ]),
    );
    expect(runtime.integrationTests).toContain("test/integration/worker-activity.integration.ts");
    expect(runtime.e2eTests).toEqual(expect.arrayContaining([...ARTIFACT_BROWSER_E2E]));
    expect(runtime.buildPackages).toEqual(
      expect.arrayContaining([
        "@opengeni/artifact-kernel-wasm-document",
        "@opengeni/artifact-kernel-wasm-presentation",
        "@opengeni/artifact-kernel-wasm-spreadsheet",
        "@opengeni/artifact-tool",
        "@opengeni/runtime",
      ]),
    );
    expect(runtime.reasons).toContainEqual({
      path: "scripts/build-artifact-runtime-target.ts",
      reason: "artifact runtime build/verification boundary",
    });

    const skill = createImpactPlan([".agents/skills/opengeni-documents/SKILL.md"]);
    expect(skill.mode).toBe("focused");
    expect(skill.affectedPackages).toContain("@opengeni/runtime");
    expect(skill.unitTests).toContain("scripts/sync-artifact-skills.test.ts");
    expect(skill.reasons).toContainEqual({
      path: ".agents/skills/opengeni-documents/SKILL.md",
      reason: "bundled artifact skill source boundary",
    });
  });

  test("React artifact UI selects its browser and full-stack acceptance coverage", () => {
    const plan = createImpactPlan([
      "packages/react/src/components/artifacts/editable-artifact-workbench.tsx",
    ]);
    expect(plan.mode).toBe("focused");
    expect(plan.affectedPackages).toEqual(
      expect.arrayContaining(["@opengeni/react", "opengeni-web"]),
    );
    expect(plan.unitTests).toEqual(
      expect.arrayContaining([
        "packages/react/test/artifact-surface.test.tsx",
        "packages/react/test/editable-artifact-workbench.test.tsx",
      ]),
    );
    expect(plan.e2eTests).toEqual(expect.arrayContaining([...ARTIFACT_BROWSER_E2E]));
    expect(plan.buildPackages).toEqual(
      expect.arrayContaining(["@opengeni/react", "@opengeni/sdk"]),
    );
  });

  test("artifact browser dependency rules do not widen unrelated leaf package plans", () => {
    const plan = createImpactPlan(["packages/ogtool/src/index.ts"]);
    expect(plan.mode).toBe("focused");
    for (const path of ARTIFACT_BROWSER_E2E) expect(plan.e2eTests).not.toContain(path);
  });

  test("artifact database migrations retain the full schema and service safety net", () => {
    const plan = createImpactPlan(["packages/db/drizzle/0191_editable_artifact_engine.sql"]);
    expect(plan.mode).toBe("full");
    expect(plan.affectedPackages).toContain("@opengeni/db");
    expect(plan.unitTests).toContain("packages/db/test/editable-artifacts-postgres.test.ts");
    expect(plan.integrationTests).toContain("test/integration/db.integration.ts");
    expect(plan.e2eTests).toEqual(expect.arrayContaining([...ARTIFACT_BROWSER_E2E]));
    expect(plan.buildPackages).toEqual(
      expect.arrayContaining(["@opengeni/db", "@opengeni/worker-bundle"]),
    );
  });

  test("root test mappings and tier ownership are complete", () => {
    expect(() => assertRootTestDependencyMapComplete()).not.toThrow();
    expect(() => assertTestTierMapComplete()).not.toThrow();
    const tests = discoverTestFiles();
    expect(tests.integration.length).toBeGreaterThan(0);
    expect(tests.e2e).toEqual([
      "test/e2e/artifact-spreadsheet-canvas.browser.e2e.ts",
      "test/e2e/artifact-spreadsheet-scroll.browser.e2e.ts",
      "test/e2e/code-editor.browser.e2e.ts",
      "test/e2e/composer-responsive.browser.e2e.ts",
      "test/e2e/connected-machine-removal.browser.e2e.ts",
      "test/e2e/editable-artifacts.browser.e2e.ts",
      "test/e2e/react-compiled-css.browser.e2e.ts",
    ]);
    expect(tests.e2e).not.toContain("test/e2e/codex-overview.e2e.ts");
    expect(OPT_IN_TESTS["test/e2e/codex-overview.e2e.ts"]).toContain("browser-acceptance");
    expect(tests.e2e).not.toContain("test/e2e/opstream-runner.e2e.ts");
  });

  test("full plans exhaustively own discovered tests and buildable projects", () => {
    const plan = createImpactPlan([], { forceFull: true });
    const tests = discoverTestFiles();
    expect(plan.unitTests).toEqual(tests.unit);
    expect(plan.integrationTests).toEqual(tests.integration);
    expect(plan.e2eTests).toEqual(tests.e2e);
    expect(plan.typecheckProjects).toEqual(typecheckProjects());
    expect(plan.typecheckProjects).toEqual(
      expect.arrayContaining(["scripts/ci", "scripts/operator", "scripts/release"]),
    );
    expect(plan.buildPackages).toEqual(
      expect.arrayContaining(["@opengeni/sdk", "@opengeni/react"]),
    );
  });

  test("written-plan console output is bounded to counts instead of echoing the full plan", () => {
    const plan = createImpactPlan([], { forceFull: true });
    const summary = impactPlanConsoleSummary(plan, "impact-plan.json");
    expect(summary.length).toBeLessThan(512);
    expect(summary).toContain(`unit=${plan.unitTests.length}`);
    expect(summary).toContain(`integration=${plan.integrationTests.length}`);
    expect(summary).toContain("output=impact-plan.json");
    expect(summary).not.toContain(plan.unitTests[0]!);
  });

  test("renames and copies retain both dependency boundaries", () => {
    expect(
      parseGitNameStatus(
        "R100\0packages/sdk/src/old.ts\0packages/react/src/new.tsx\0C087\0packages/db/src/a.ts\0packages/core/src/b.ts\0",
      ),
    ).toEqual([
      "packages/core/src/b.ts",
      "packages/db/src/a.ts",
      "packages/react/src/new.tsx",
      "packages/sdk/src/old.ts",
    ]);
    expect(() => parseGitNameStatus("R100\0packages/sdk/src/old.ts\0")).toThrow(
      "missing destination",
    );
  });
});

describe("deterministic bounded execution", () => {
  test("shards are deterministic, disjoint, and exhaustive", () => {
    const files = discoverTestFiles().unit.slice(0, 31);
    const first = deterministicShards(process.cwd(), files, 4);
    const second = deterministicShards(process.cwd(), [...files].reverse(), 4);
    expect(second).toEqual(first);
    expect(first.flat().sort()).toEqual([...files].sort());
    expect(new Set(first.flat()).size).toBe(files.length);
  });

  test("batching rejects unsafe sizes and preserves order", () => {
    expect(deterministicFileBatches(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(() => deterministicFileBatches(["a"], 0)).toThrow("positive integer");
  });

  test("process-global tests are isolated and custom suffixes are explicit", () => {
    expect(fileUsesProcessGlobalTestState(process.cwd(), "apps/web/src/App.test.ts")).toBe(true);
    expect(fileUsesProcessGlobalTestState(process.cwd(), "packages/sdk/test/client.test.ts")).toBe(
      false,
    );
    expect(explicitBunTestPath("test/integration/api.integration.ts")).toBe(
      "./test/integration/api.integration.ts",
    );
    expect(explicitBunTestPath("./test/e2e/browser.e2e.ts")).toBe("./test/e2e/browser.e2e.ts");
  });

  test("browser runner selection includes ordinary and named browser suites", () => {
    expect(usesBrowserRunner("test/e2e/browser.e2e.ts")).toBe(true);
    expect(usesBrowserRunner("test/e2e/codex-overview.e2e.ts")).toBe(true);
    expect(usesBrowserRunner("test/e2e/queue-surface.browser.e2e.ts")).toBe(true);
    expect(usesBrowserRunner("test/e2e/sandbox.e2e.ts")).toBe(false);
  });

  test("test environments scrub ambient OpenGeni state and preserve only fail-closed DB intent", () => {
    expect(
      sanitizedTestEnvironment({
        PATH: "/bin",
        OPENGENI_API_KEY: "secret",
        OPENGENI_REQUIRE_REAL_DB: "1",
      }),
    ).toEqual({
      PATH: "/bin",
      NODE_ENV: "test",
      OPENGENI_TEST_HERMETIC: "1",
      OPENGENI_REQUIRE_REAL_DB: "1",
    });
    expect(sanitizedTestEnvironment({ OPENGENI_OTHER: "value" })).toEqual({
      NODE_ENV: "test",
      OPENGENI_TEST_HERMETIC: "1",
    });
  });

  test("missing or stale timing evidence falls back to source-byte planning", () => {
    const resolution = integrationShardWeights(process.cwd());
    expect(resolution.mode).toBe("source-bytes");
    expect(resolution.weights).toBeNull();
    expect(resolution.profileSha256).toBeNull();
    expect(resolution.reason.length).toBeGreaterThan(0);
  });

  test("one-file runners preserve canonical serial Bun semantics", () => {
    for (const path of ["scripts/ci/run-unit-shard.ts", "scripts/ci/run-test-shard.ts"]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain('"--parallel=1"');
      expect(source).not.toContain('"--isolate"');
      expect(source).toContain("--max-concurrency=${budget.concurrency}");
    }
  });
});

function requiredResult(
  input: Record<string, { result: string }>,
  options: {
    event: "pull_request" | "push" | "schedule" | "workflow_dispatch";
    mode: "docs" | "focused" | "full";
    unit: number;
    integration: number;
    build: number;
  },
): boolean {
  const result = spawnSync(
    "jq",
    [
      "-e",
      "--arg",
      "event",
      options.event,
      "--arg",
      "mode",
      options.mode,
      "--argjson",
      "unit",
      String(options.unit),
      "--argjson",
      "integration",
      String(options.integration),
      "--argjson",
      "build",
      String(options.build),
      "-f",
      "scripts/ci/required-results.jq",
    ],
    { input: JSON.stringify(input), encoding: "utf8" },
  );
  return result.status === 0;
}

describe("workflow fail-closed contracts", () => {
  test("required-results accepts exact selected/skipped topology and rejects missing success", () => {
    const full = {
      plan: { result: "success" },
      "source-contracts": { result: "success" },
      "unit-shards": { result: "success" },
      "unit-safety": { result: "skipped" },
      "integration-shards": { result: "success" },
      "test-suite": { result: "success" },
      "browser-acceptance": { result: "success" },
      "package-contracts": { result: "success" },
      deployment: { result: "success" },
      images: { result: "success" },
    };
    expect(
      requiredResult(full, {
        event: "pull_request",
        mode: "full",
        unit: 1,
        integration: 1,
        build: 1,
      }),
    ).toBe(true);
    expect(
      requiredResult(
        { ...full, "integration-shards": { result: "failure" } },
        {
          event: "pull_request",
          mode: "full",
          unit: 1,
          integration: 1,
          build: 1,
        },
      ),
    ).toBe(false);
    expect(
      requiredResult(
        {
          ...full,
          "unit-shards": { result: "skipped" },
          "unit-safety": { result: "skipped" },
          "integration-shards": { result: "skipped" },
          "test-suite": { result: "skipped" },
          "browser-acceptance": { result: "skipped" },
          "package-contracts": { result: "skipped" },
          deployment: { result: "skipped" },
          images: { result: "skipped" },
        },
        {
          event: "pull_request",
          mode: "docs",
          unit: 0,
          integration: 0,
          build: 0,
        },
      ),
    ).toBe(true);
  });

  test("CI preserves trusted admission while planning candidate jobs from the exact head", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const admission = ci.slice(ci.indexOf("  automation-admission:"), ci.indexOf("  plan:"));
    expect(admission).toContain("ref: ${{ github.sha }}");
    expect(admission).toContain("bun-version: 1.3.14");
    expect(admission).not.toContain("bun-version-file: .bun-version");
    expect(ci).toContain("  plan:\n    name: Explain change impact");
    expect(ci).toContain(
      "ref: ${{ github.event_name == 'workflow_dispatch' && inputs.automation_head_sha || github.event.pull_request.head.sha || github.sha }}",
    );
    expect(ci).toContain("bun-version-file: .bun-version");
    expect(ci).toContain('bun scripts/ci/impact.ts --base "$BASE_SHA" --head "$HEAD_SHA"');
    expect(ci).toContain("bun scripts/ci/impact.ts --full --output impact-plan.json");
    expect(ci).not.toContain("jq . impact-plan.json");
    expect(ci).toContain("changedCount:(.changedFiles|length)");

    const sourceContracts = ci.slice(
      ci.indexOf("  source-contracts:"),
      ci.indexOf("  unit-shards:"),
    );
    expect(sourceContracts).toContain("path: ${{ runner.temp }}/ci-impact-plan");
    expect(sourceContracts).toContain("--plan ${{ runner.temp }}/ci-impact-plan/impact-plan.json");
    expect(sourceContracts).not.toContain("--plan impact-plan.json");
  });

  test("CI retains exact aggregate names and every current release/image lane", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("name: Typecheck and unit tests");
    expect(ci).toContain("name: Workload image builds");
    expect(ci).toContain("name: Admit automation Version PR");
    expect(ci).toContain("name: Report exact-head automation CI");
    expect(ci).toContain("name: Deployment artifacts");
    expect(ci).toContain("name: Browser and visual acceptance");
    expect(ci).toContain("name: Real-service and recovery tests");
    expect(ci).toContain("name: Package and bundle contracts");
    expect(ci).toContain("name: React Native Metro to Hermes session bundle");
    expect(ci).toContain("run: bun run test:react-native-hermes-bundle");
    expect(ci).toContain("api_digest: ${{ steps.api_image.outputs.digest }}");
    expect(ci).toContain("worker_digest: ${{ steps.worker_image.outputs.digest }}");
    expect(ci).toContain("web_digest: ${{ steps.web_image.outputs.digest }}");
    expect(ci).toContain("relay_digest: ${{ steps.relay_image.outputs.digest }}");
    expect(ci).toContain("sandbox_digest: ${{ steps.sandbox_image.outputs.digest }}");
    expect(ci).toContain("dogfood-images-${{ github.sha }}");
  });

  test("selected CI work is profiled and memory bounded", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    for (const script of [
      "run-typecheck-plan.ts",
      "run-guards-plan.ts",
      "run-unit-shard.ts",
      "run-test-shard.ts",
      "run-build-plan.ts",
    ]) {
      expect(ci).toContain(`scripts/ci/${script}`);
    }
    expect(ci.match(/scripts\/ci\/profile-command\.ts/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(ci).toContain("scripts/ci/required-results.jq");
    expect(ci).toContain("scripts/ci/resource-budget.test.ts");
    expect(ci).toContain("scripts/ci/profile-command.test.ts");
  });
});
