import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertRootTestDependencyMapComplete,
  createImpactPlan,
  parseGitNameStatus,
  TEMPORAL_WORKFLOW_INTEGRATION_TESTS,
  TEMPORAL_WORKFLOW_TEST_HELPER,
} from "./impact";
import {
  assertTestTierMapComplete,
  deterministicFileBatches,
  deterministicShards,
  discoverTestFiles,
  fileUsesProcessGlobalTestState,
  typecheckProjects,
} from "./workspace";

describe("fail-closed change impact", () => {
  test("documentation-only changes run only documentation guards", () => {
    const plan = createImpactPlan(["docs/toolchain.md", "README.md"]);
    expect(plan.mode).toBe("docs");
    expect(plan.unitTests).toEqual([]);
    expect(plan.guards).toEqual(["format", "docs-refs"]);
  });

  test.each([
    "bun.lock",
    ".bun-version",
    ".github/workflows/ci.yml",
    ".dockerignore",
    "scripts/release-publish.sh",
    "packages/db/drizzle/0042_example.sql",
    "packages/agent-proto/src/gen/opengeni_agent.ts",
    "unknown/new-root.ts",
    "test/integration/new-unmapped.integration.ts",
  ])("%s activates the full safety net", (path) => {
    const plan = createImpactPlan([path]);
    expect(plan.mode).toBe("full");
    expect(plan.unitTests.length).toBeGreaterThan(100);
    expect(plan.reasons.some((reason) => reason.path === path)).toBe(true);
  });

  test("a package source change selects it, reverse dependents, and relevant tests", () => {
    const plan = createImpactPlan(["packages/sdk/src/client.ts"]);
    expect(plan.mode).toBe("focused");
    expect(plan.affectedPackages).toContain("@opengeni/sdk");
    expect(plan.affectedPackages).toContain("@opengeni/react");
    expect(plan.affectedPackages).toContain("opengeni-web");
    expect(plan.typecheckProjects).toContain("packages/sdk");
    expect(plan.unitTests).toContain("packages/sdk/test/client.test.ts");
    expect(plan.e2eTests).toContain("test/e2e/browser.e2e.ts");
    expect(plan.integrationTests.every((path) => !path.startsWith("packages/db/"))).toBe(true);
  });

  test("the version-linked SDK and React outputs are selected atomically", () => {
    const plan = createImpactPlan(["packages/react/src/index.ts"]);
    expect(plan.mode).toBe("focused");
    expect(plan.buildPackages).toContain("@opengeni/react");
    expect(plan.buildPackages).toContain("@opengeni/sdk");
  });

  test("root-test import dependencies cannot drift below focused selection", () => {
    expect(() => assertRootTestDependencyMapComplete()).not.toThrow();
    for (const [changed, selected] of [
      ["packages/react/src/index.ts", ["test/integration/api.integration.ts"]],
      [
        "packages/events/src/index.ts",
        ["test/integration/selfhosted-control-transport.integration.ts"],
      ],
      [
        "packages/testing/src/index.ts",
        ["test/integration/selfhosted-control-transport.integration.ts"],
      ],
      [
        "apps/api/src/index.ts",
        [
          "test/integration/worker-activity.integration.ts",
          "test/integration/worker-restart.integration.ts",
        ],
      ],
    ] as const) {
      expect(createImpactPlan([changed]).integrationTests).toEqual(
        expect.arrayContaining(selected),
      );
    }
  });

  test("a deleted package test cannot silently remove package coverage", () => {
    const plan = createImpactPlan(["packages/sdk/test/deleted.test.ts"]);
    expect(plan.mode).toBe("focused");
    expect(plan.unitTests).not.toContain("packages/sdk/test/deleted.test.ts");
    expect(plan.unitTests).toContain("packages/sdk/test/client.test.ts");
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

  test("CI, desktop E2E, and images share one exact Bun toolchain fence", async () => {
    const version = (await Bun.file(".bun-version").text()).trim();
    const [ci, desktop, dockerfile] = await Promise.all([
      Bun.file(".github/workflows/ci.yml").text(),
      Bun.file(".github/workflows/desktop-e2e.yml").text(),
      Bun.file("docker/opengeni.Dockerfile").text(),
    ]);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ci).toContain("bun-version-file: .bun-version");
    expect(desktop).toContain("bun-version-file: .bun-version");
    expect(`${ci}\n${desktop}`).not.toContain("bun-version: latest");
    expect(dockerfile).toMatch(
      new RegExp(
        `^FROM oven/bun:${version.replaceAll(".", "\\.")}@sha256:[0-9a-f]{64} AS dependencies`,
        "m",
      ),
    );
  });

  test("the immutable NATS auth-callout gate fails fast when its server exits", () => {
    const integration = readFileSync(
      "test/integration/selfhosted-auth-callout.integration.ts",
      "utf8",
    );
    expect(integration).toContain(
      "while (Date.now() < deadline) {\n    if (proc.exitCode !== null) break;",
    );
  });

  test("workload images use one shared bake graph and one dependency install layer", () => {
    const bake = readFileSync("docker/docker-bake.hcl", "utf8");
    const dockerfile = readFileSync("docker/opengeni.Dockerfile", "utf8");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(bake).toContain('group "workload-images"');
    expect(bake).toContain('targets = ["api", "worker", "web"]');
    expect(bake).toContain('group "release-images"');
    expect(bake).toContain('targets = ["api", "worker", "web", "relay"]');
    expect(dockerfile.match(/bun install --frozen-lockfile/g)).toHaveLength(1);
    expect(dockerfile).toContain("FROM source AS worker");
    expect(dockerfile.match(/^COPY --chown=bun:bun \. \.$/gm)).toHaveLength(1);
    expect(dockerfile.indexOf("RUN apt-get update")).toBeLessThan(
      dockerfile.indexOf("COPY package.json bun.lock tsconfig.base.json ./"),
    );
    expect(dockerfile).toContain("--mount=type=cache,target=/root/.bun/install/cache");
    const dependenciesStage = dockerfile.split("FROM dependencies AS source")[0] ?? "";
    expect(dependenciesStage).not.toContain("OPENGENI_SERVER_VERSION");
    expect(dockerfile.indexOf("ARG OPENGENI_SERVER_VERSION")).toBeGreaterThan(
      dockerfile.indexOf("RUN bun install --frozen-lockfile"),
    );
    expect(dockerfile).toContain(
      "FROM docker:29.6.1-cli@sha256:862099ada15c669000bef53aa4cb9d821262829f45b0dda2159ccb276443043b AS docker-cli",
    );
    expect(dockerfile).not.toContain("docker-ce-cli");
    const relay = readFileSync("agent/crates/opengeni-relay/Dockerfile", "utf8");
    expect(relay).toMatch(/^FROM rust:1\.82-alpine@sha256:[0-9a-f]{64} AS build/m);
    expect(relay).toMatch(
      /^FROM gcr\.io\/distroless\/static-debian12:nonroot@sha256:[0-9a-f]{64} AS runtime/m,
    );
    expect(relay.indexOf("RUN rustup target add")).toBeLessThan(relay.indexOf("COPY . ."));
    expect(relay).toContain("cargo build --locked --release");
    for (const target of ["api", "worker", "web"]) {
      expect(ci).toContain(
        `${target}.cache-to=type=gha,scope=opengeni-workload-${target},mode=max`,
      );
    }
    expect(ci).not.toContain("*.cache-to=type=gha,scope=opengeni-workloads");
    expect(ci).not.toContain("path: node_modules");
    expect(ci).not.toContain("dependencies-v3-");
    expect(ci.match(/~\/\.bun\/install\/cache/g)).toHaveLength(8);
    expect(ci.match(/bun-store-v1-/g)).toHaveLength(8);
    expect(ci.match(/rm -rf node_modules/g)).toHaveLength(8);
    expect(ci.match(/bun install --frozen-lockfile/g)).toHaveLength(8);
    expect(ci).toContain("key: bun-store-v1-");
    expect(ci.indexOf("Install exact dependency tree")).toBeLessThan(
      ci.indexOf("Build fail-closed impact plan"),
    );
    expect(() => Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"))).not.toThrow();
  });

  test("typecheck discovery contains every current app/package project", () => {
    const projects = typecheckProjects();
    expect(projects).toContain("scripts/ci");
    expect(projects).toContain("scripts/operator");
    expect(projects).toContain("apps/api");
    expect(projects).toContain("apps/worker");
    expect(projects).toContain("apps/web");
    expect(new Set(projects).size).toBe(projects.length);
  });

  test("full build selection contains only cache-builder-known publishable packages", () => {
    const plan = createImpactPlan([], { forceFull: true });
    expect(plan.buildPackages).not.toContain("@opengeni/deployment");
    expect(plan.buildPackages).not.toContain("@opengeni/testing");
    expect(plan.buildPackages).toContain("@opengeni/contracts");
  });

  test("every root integration/E2E file is full-gated or explicitly opt-in", () => {
    expect(() => assertTestTierMapComplete()).not.toThrow();
    const tests = discoverTestFiles();
    expect(tests.integration).not.toContain("test/integration/workspace-capture.integration.ts");
    expect(tests.e2e).not.toContain("packages/runtime/test/codex-live.e2e.ts");
    expect(tests.e2e).not.toContain("apps/worker/test/desktop-image.e2e.ts");
    expect(tests.e2e).not.toContain("test/e2e/opstream-runner.e2e.ts");
    expect(tests.e2e).toContain("test/e2e/rig-verification.e2e.ts");
    expect(tests.e2e).toContain("test/e2e/session-pins.browser.e2e.ts");
  });

  test("Temporal split files and helper stay in the full safety net", () => {
    const discovered = discoverTestFiles().integration;
    expect(discovered).not.toContain("test/integration/temporal-workflow.integration.ts");
    for (const path of TEMPORAL_WORKFLOW_INTEGRATION_TESTS) {
      expect(discovered).toContain(path);
      expect(readFileSync(path, "utf8")).toContain("createTemporalWorkflowTestContext");
    }

    const helperPlan = createImpactPlan([TEMPORAL_WORKFLOW_TEST_HELPER]);
    expect(helperPlan.mode).toBe("focused");
    expect(helperPlan.integrationTests).toEqual(
      expect.arrayContaining([...TEMPORAL_WORKFLOW_INTEGRATION_TESTS]),
    );
    expect(helperPlan.reasons).toContainEqual({
      path: TEMPORAL_WORKFLOW_TEST_HELPER,
      reason: "explicit root integration helper dependency rule (6 tests)",
    });
  });

  test("OPE-26 session-pin boundaries select its browser acceptance", () => {
    for (const changed of [
      "apps/web/src/lib/session-pins.ts",
      "packages/sdk/src/client.ts",
      "packages/db/src/index.ts",
      "apps/api/src/routes/sessions.ts",
    ]) {
      const plan = createImpactPlan([changed]);
      expect(plan.e2eTests).toContain("test/e2e/session-pins.browser.e2e.ts");
    }
  });

  test("focused runners bound build memory and use unambiguous Bun worker counts", () => {
    const packageBuilder = readFileSync("scripts/build-publishable-packages.ts", "utf8");
    const unitRunner = readFileSync("scripts/ci/run-unit-shard.ts", "utf8");
    const serviceRunner = readFileSync("scripts/ci/run-test-shard.ts", "utf8");
    expect(packageBuilder).toContain('NODE_OPTIONS = "--max-old-space-size=1536"');
    expect(unitRunner).toContain('"--parallel=1"');
    expect(unitRunner).toContain('OPENGENI_TEST_FILES_PER_PROCESS ?? "1"');
    expect(serviceRunner).toContain('"--parallel=1"');
    expect(serviceRunner).toContain('env.OPENGENI_REQUIRE_REAL_DB = "1"');
    expect(serviceRunner).toContain('path.endsWith(".browser.e2e.ts")');
    expect(serviceRunner).toContain("needsOpe26SessionPins: selected.includes(ope26SessionPins)");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("needs_ope26_session_pins=$(jq -r .needsOpe26SessionPins");
    expect(ci).toContain("Upload OPE-26 session pin visual evidence");
    expect(ci).toContain("/tmp/ope26-session-pin-mobile-dark.png");
    expect(ci).toContain(
      "integration_matrix=$(matrix \"$(jq '.integrationTests | length' impact-plan.json)\" 6)",
    );
    expect(unitRunner).not.toMatch(/"--parallel",\s*"1"/);
    expect(serviceRunner).not.toMatch(/"--parallel",\s*"1"/);
  });
});

describe("deterministic sharding and isolation", () => {
  test("Temporal split projection is exhaustive with a bounded six-shard critical weight", () => {
    const integration = discoverTestFiles().integration;
    const shards = deterministicShards(process.cwd(), integration, 6);
    const assigned = shards.flat().sort();
    expect(assigned).toEqual([...integration].sort());
    expect(new Set(assigned).size).toBe(integration.length);

    const temporalFiles = new Set<string>(TEMPORAL_WORKFLOW_INTEGRATION_TESTS);
    const temporalShardWeights = shards.map((files) =>
      files
        .filter((path) => temporalFiles.has(path))
        .reduce((total, path) => total + readFileSync(path).byteLength, 0),
    );
    expect(temporalShardWeights.filter((weight) => weight > 0).length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...temporalShardWeights)).toBeLessThan(60_000);
  });

  test("LPT sharding is deterministic, exhaustive, and duplicate-free", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-shards-"));
    for (const [name, contents] of [
      ["a.test.ts", "a".repeat(100)],
      ["b.test.ts", "b".repeat(90)],
      ["c.test.ts", "c".repeat(20)],
      ["d.test.ts", "d".repeat(10)],
    ] as const) {
      writeFileSync(join(root, name), contents);
    }
    const files = ["d.test.ts", "b.test.ts", "a.test.ts", "c.test.ts", "a.test.ts"];
    const first = deterministicShards(root, files, 2);
    const second = deterministicShards(root, [...files].reverse(), 2);
    expect(first).toEqual(second);
    expect(first.flat().sort()).toEqual(["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"]);
  });

  test("DOM, environment mutation, mock.module, and missing files require process isolation", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-isolation-"));
    writeFileSync(join(root, "plain.test.ts"), "test('plain', () => {})");
    writeFileSync(join(root, "mock.test.ts"), "mock.module('x', () => ({}))");
    writeFileSync(join(root, "env.test.ts"), "delete process.env.OPENGENI_DATABASE_URL");
    expect(fileUsesProcessGlobalTestState(root, "component.test.tsx")).toBe(true);
    expect(fileUsesProcessGlobalTestState(root, "mock.test.ts")).toBe(true);
    expect(fileUsesProcessGlobalTestState(root, "env.test.ts")).toBe(true);
    expect(fileUsesProcessGlobalTestState(root, "plain.test.ts")).toBe(false);
    expect(fileUsesProcessGlobalTestState(root, "missing.test.ts")).toBe(true);
  });

  test("unit process batches are deterministic and hard-bounded", () => {
    expect(deterministicFileBatches(["a", "b", "c", "d", "e"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
    expect(() => deterministicFileBatches(["a"], 0)).toThrow("positive integer");
  });

  test("required CI rejects selected skips, failures, and cancellations", () => {
    const success = {
      plan: { result: "success" },
      typecheck: { result: "success" },
      guards: { result: "success" },
      unit: { result: "success" },
      integration: { result: "success" },
      e2e: { result: "success" },
      packages: { result: "success" },
      deployment: { result: "success" },
      images: { result: "success" },
    };
    const evaluate = (results: typeof success, counts = [1, 1, 1, 1], mode = "full") =>
      spawnSync(
        "jq",
        [
          "-e",
          "--arg",
          "mode",
          mode,
          "--argjson",
          "unit",
          String(counts[0]),
          "--argjson",
          "integration",
          String(counts[1]),
          "--argjson",
          "e2e",
          String(counts[2]),
          "--argjson",
          "build",
          String(counts[3]),
          "-f",
          "scripts/ci/required-results.jq",
        ],
        { input: JSON.stringify(results), encoding: "utf8" },
      ).status;
    expect(evaluate(success)).toBe(0);
    expect(evaluate({ ...success, unit: { result: "skipped" } })).not.toBe(0);
    expect(evaluate({ ...success, integration: { result: "cancelled" } })).not.toBe(0);
    expect(evaluate({ ...success, images: { result: "failure" } })).not.toBe(0);
    const docs = {
      ...success,
      unit: { result: "skipped" },
      integration: { result: "skipped" },
      e2e: { result: "skipped" },
      packages: { result: "skipped" },
      deployment: { result: "skipped" },
      images: { result: "skipped" },
    };
    expect(evaluate(docs, [0, 0, 0, 0], "docs")).toBe(0);
  });
});
