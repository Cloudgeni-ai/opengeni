import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertRootTestDependencyMapComplete,
  createImpactPlan,
  parseGitNameStatus,
  TEMPORAL_WORKFLOW_INTEGRATION_TESTS,
} from "./impact";
import {
  assertTestTierMapComplete,
  deterministicFileBatches,
  deterministicShards,
  discoverTestFiles,
  fileUsesProcessGlobalTestState,
  integrationShardWeights,
  typecheckProjects,
} from "./workspace";
import { sanitizedTestEnvironment } from "./run-unit-shard";
import { explicitBunTestPath } from "./run-test-shard";

describe("fail-closed change impact", () => {
  test("documentation-only changes run only non-runtime guards", () => {
    const plan = createImpactPlan(["docs/toolchain.md", "README.md"]);
    expect(plan.mode).toBe("docs");
    expect(plan.unitTests).toEqual([]);
    expect(plan.guards).toEqual(["format", "docs-refs", "generated-fonts"]);
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
    expect(plan.affectedPackages).toContain("@opengeni/example-northstar-support");
    expect(plan.typecheckProjects).toContain("packages/sdk");
    expect(plan.unitTests).toContain("packages/sdk/test/client.test.ts");
    expect(plan.e2eTests).toContain("test/e2e/browser.e2e.ts");
    expect(plan.exampleBuildProjects).toContain("examples/northstar-support");
    expect(plan.integrationTests.every((path) => !path.startsWith("packages/db/"))).toBe(true);
  });

  test("example-only and full plans typecheck and build the example workspace", () => {
    for (const plan of [
      createImpactPlan(["examples/northstar-support/src/main.tsx"]),
      createImpactPlan([], { forceFull: true }),
    ]) {
      expect(plan.typecheckProjects).toContain("examples/northstar-support");
      expect(plan.exampleBuildProjects).toContain("examples/northstar-support");
      expect(plan.guards).toContain("example-builds");
    }
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
    expect(ci).not.toContain("~/.cache/ms-playwright");
    expect(desktop).not.toContain("actions/cache");
    expect(desktop).not.toContain("~/.bun/install/cache");
    expect(desktop).toContain("BUN_INSTALL_CACHE_DIR: ${{ runner.temp }}/opengeni-bun-store");
    expect(desktop).toContain('rm -rf node_modules "$BUN_INSTALL_CACHE_DIR"');
    expect(desktop).toContain("bun install --frozen-lockfile --backend=copyfile");
    expect(dockerfile).toMatch(
      new RegExp(
        `^FROM oven/bun:${version.replaceAll(".", "\\.")}@sha256:[0-9a-f]{64} AS dependencies`,
        "m",
      ),
    );
  });

  test("the immutable NATS auth-callout gate runs on stock Docker CI and fails fast", () => {
    const integration = readFileSync(
      "test/integration/selfhosted-auth-callout.integration.ts",
      "utf8",
    );
    expect(integration).toContain('process.env.OPENGENI_TEST_REQUIRE_DOCKER === "1"');
    expect(integration).toMatch(/nats:2\.10\.29-alpine@sha256:[0-9a-f]{64}/);
    expect(integration).toContain('"--network",\n          "host"');
    expect(integration).toContain('Bun.spawn(["docker", "rm", "--force", name]');
    expect(integration).toContain('["nix", "run", "nixpkgs#nats-server"');
    expect(integration).toContain(
      "while (Date.now() < deadline) {\n    if (proc.exitCode !== null) break;",
    );
  });

  test("required test-service images use explicit versions and manifest-list digests", () => {
    const imageMap = readFileSync("packages/testing/src/service-images.ts", "utf8");
    const compose = readFileSync("packages/testing/src/compose.ts", "utf8");
    const sharedPostgres = readFileSync("packages/testing/src/shared-pg.ts", "utf8");
    const imageReferences = [...imageMap.matchAll(/^\s+\w+:\s*"([^"]+)",?$/gm)].map(
      (match) => match[1]!,
    );

    expect(imageReferences).toHaveLength(6);
    for (const reference of imageReferences) {
      expect(reference).toMatch(/^[a-z0-9][a-z0-9./-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
      expect(reference).not.toMatch(/:latest@/);
    }

    const composeImageLines = compose.match(/^\s+image:\s+.*$/gm) ?? [];
    expect(composeImageLines).toHaveLength(5);
    for (const line of composeImageLines) {
      expect(line).toContain("${TEST_SERVICE_IMAGES.");
    }
    expect(sharedPostgres).toContain("const IMAGE = TEST_SERVICE_IMAGES.pgvectorPg16;");
  });

  test("Channel-A creates its git fixture before using it and checks process exits", () => {
    const e2e = readFileSync("test/e2e/channel-a.e2e.ts", "utf8");
    expect(e2e).toContain("mkdir -p repo && git -C repo init -q");
    for (const result of ["init", "commit", "stage"]) {
      expect(e2e).toContain(
        `expect(((await ${result}.json()) as { exitCode: number }).exitCode).toBe(0);`,
      );
    }
  });

  test("the rig-setup E2E observes the dedicated lifecycle event contract", () => {
    const e2e = readFileSync("test/e2e/rig-setup.e2e.ts", "utf8");
    expect(e2e).toContain('e.type.startsWith("rig.setup.")');
    for (const type of ["started", "completed", "skipped", "failed"]) {
      expect(e2e).toContain(`rig.setup.${type}`);
    }
    expect(e2e).not.toContain('e.type.startsWith("sandbox.operation.")');
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
    expect(ci).not.toContain("~/.bun/install/cache");
    expect(ci).not.toContain("bun-store-v1-");
    expect(ci).not.toContain("actions/cache/restore");
    expect(ci.match(/BUN_INSTALL_CACHE_DIR:/g)).toHaveLength(8);
    expect(ci.match(/rm -rf node_modules/g)).toHaveLength(8);
    expect(ci.match(/bun install --frozen-lockfile/g)).toHaveLength(8);
    expect(ci.match(/--backend=copyfile/g)).toHaveLength(8);
    expect(ci).toContain('kind:"fresh-bun-package-store"');
    expect(ci).toContain("path: ${{ runner.temp }}/opengeni-impact-plan");
    expect(ci).toContain("--plan ${{ runner.temp }}/opengeni-impact-plan/impact-plan.json");
    expect(ci.indexOf("Install exact dependency tree")).toBeLessThan(
      ci.indexOf("Build fail-closed impact plan"),
    );
    expect(() => Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"))).not.toThrow();
  });

  test("every pull-request workflow checks out and fingerprints the exact PR head", () => {
    const exactHead = "${{ github.event.pull_request.head.sha || github.sha }}";
    type Workflow = {
      jobs?: Record<
        string,
        {
          steps?: Array<{
            uses?: string;
            with?: Record<string, unknown>;
            env?: Record<string, unknown>;
          }>;
        }
      >;
    };
    const parsed = new Map<string, Workflow>();
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/workflows/agent-ci.yml",
      ".github/workflows/desktop-e2e.yml",
    ]) {
      const workflow = Bun.YAML.parse(readFileSync(path, "utf8")) as Workflow;
      parsed.set(path, workflow);
      const checkouts = Object.values(workflow.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.uses === "actions/checkout@v6");
      expect(checkouts.length).toBeGreaterThan(0);
      for (const checkout of checkouts) expect(checkout.with?.ref).toBe(exactHead);
    }

    const ci = parsed.get(".github/workflows/ci.yml")!;
    const packageSteps = ci.jobs?.packages?.steps ?? [];
    const cacheKey = packageSteps.find((step) => step.uses === "actions/cache@v6.1.0")?.with?.key;
    expect(cacheKey).toBeString();
    expect(String(cacheKey).endsWith(exactHead)).toBe(true);
    const imageBuild = ci.jobs?.images?.steps?.find(
      (step) => step.uses === "docker/bake-action@v6",
    );
    expect(imageBuild?.with?.source).toBe(".");
    const sourceSha = imageBuild?.env?.SOURCE_SHA;
    expect(sourceSha).toBe(exactHead);
  });

  test("typecheck discovery contains every current app/example/package project", () => {
    const projects = typecheckProjects();
    expect(projects).toContain("scripts/ci");
    expect(projects).not.toContain("scripts/operator");
    expect(projects).toContain("apps/api");
    expect(projects).toContain("apps/worker");
    expect(projects).toContain("apps/web");
    expect(projects).toContain("examples/northstar-support");
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
    expect(tests.e2e).toContain("test/e2e/sandbox.e2e.ts");
  });

  test("the current Temporal workflow monolith stays in the full safety net exactly once", () => {
    const discovered = discoverTestFiles().integration;
    expect(TEMPORAL_WORKFLOW_INTEGRATION_TESTS).toEqual([
      "test/integration/temporal-workflow.integration.ts",
    ]);
    expect(discovered.filter((path) => path.includes("temporal-workflow"))).toEqual([
      "test/integration/temporal-workflow.integration.ts",
    ]);
    expect(readFileSync(TEMPORAL_WORKFLOW_INTEGRATION_TESTS[0], "utf8")).toContain(
      'describe("Temporal workflow integration"',
    );
    expect(createImpactPlan(["apps/worker/src/workflows/session.ts"]).integrationTests).toContain(
      TEMPORAL_WORKFLOW_INTEGRATION_TESTS[0],
    );
  });

  test("OPE-22 incident regressions remain named and selected by the full safety net", () => {
    const mcpName =
      "an MCP stream timeout after a successful tool output checkpoints once and recovers the same turn";
    const compactionName =
      "forced overflow compaction proves shrink against active history, not stale input tokens";
    const full = createImpactPlan([], { forceFull: true });
    expect(full.integrationTests).toContain("test/integration/worker-activity.integration.ts");
    expect(full.unitTests).toContain("apps/worker/test/context-compaction-activity.test.ts");
    expect(readFileSync("test/integration/worker-activity.integration.ts", "utf8")).toContain(
      mcpName,
    );
    expect(readFileSync("apps/worker/test/context-compaction-activity.test.ts", "utf8")).toContain(
      compactionName,
    );
  });

  test("React warning acceptance remains an independent required guard", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const warningGate = readFileSync("scripts/test-react-clean.ts", "utf8");
    expect(ci).toContain("React warning-free acceptance");
    expect(ci).toContain("run: bun run test:react:clean");
    expect(packageJson.scripts?.["test:react:clean"]).toBe("bun scripts/test-react-clean.ts");
    expect(warningGate).toContain("React tests emitted runtime warnings:");
  });

  test("current-main release, generated-source, consumer, and capture gates remain required", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const release = readFileSync(".github/workflows/release.yml", "utf8");
    const guards = readFileSync("scripts/ci/run-guards-plan.ts", "utf8");
    const closureGuard = readFileSync("scripts/publish-closure-guard.ts", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const full = createImpactPlan([], { forceFull: true });

    expect(full.guards).toContain("generated-fonts");
    expect(guards).toContain('"generated-fonts": ["bun", "run", "check:generated-fonts"]');
    expect(packageJson.scripts?.["check:generated-fonts"]).toBe(
      "bun scripts/generate-noto-jp-loader.ts --check",
    );
    expect(ci).toContain("Validate changeset release plan");
    expect(ci).toContain("Version PR tree does not exactly reproduce 'changeset version'");
    expect(ci).toContain("pending changesets target only ignored/private packages");
    expect(ci).toContain("Clean published consumer");
    expect(ci).toContain("-- bun run test:publish-consumer");
    expect(ci.indexOf("Restore or build content-addressed package outputs")).toBeLessThan(
      ci.indexOf("Clean published consumer"),
    );
    expect(ci).toContain("args+=(--require-client-dist)");
    expect(
      release.match(/bun scripts\/publish-closure-guard\.ts --require-client-dist/g),
    ).toHaveLength(2);
    expect(packageJson.scripts?.["closure-guard"]).toBe(
      "bun run build:packages && bun scripts/publish-closure-guard.ts --require-client-dist",
    );
    expect(closureGuard).not.toContain('spawnSync("bun", ["run", "build"]');
    expect(closureGuard).toContain("if (requireClientDist)");
    expect(closureGuard).toContain("Build the selected package outputs exactly once");
    expect(full.e2eTests).toContain("test/e2e/sandbox.e2e.ts");
    expect(readFileSync("test/e2e/sandbox.e2e.ts", "utf8")).toContain(
      "captures a real turn-end multi-repository workspace through the public API",
    );
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

  test("workbench dependencies select acceptance and only its shard requests its evidence", () => {
    for (const changed of [
      "packages/react/src/components/sandbox-workspace.tsx",
      "packages/testing/src/process.ts",
    ]) {
      expect(createImpactPlan([changed]).e2eTests).toContain("test/e2e/workbench.browser.e2e.ts");
    }

    const root = mkdtempSync(join(tmpdir(), "opengeni-workbench-selection-"));
    const planPath = join(root, "impact-plan.json");
    writeFileSync(planPath, JSON.stringify(createImpactPlan([], { forceFull: true })));
    const selections = Array.from({ length: 3 }, (_, index) => {
      const result = spawnSync(
        "bun",
        [
          "scripts/ci/run-test-shard.ts",
          "--plan",
          planPath,
          "--tier",
          "e2e",
          "--shard",
          String(index),
          "--shards",
          "3",
          "--list-json",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout) as { files: string[]; needsWorkbench: boolean };
    });
    expect(selections.filter((selection) => selection.needsWorkbench)).toHaveLength(1);
    expect(selections.find((selection) => selection.needsWorkbench)?.files).toContain(
      "test/e2e/workbench.browser.e2e.ts",
    );

    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("needs_workbench=$(jq -r .needsWorkbench");
    expect(ci).toContain("steps.e2e-selection.outputs.needs_workbench == 'true'");
    expect(ci).toContain("Upload workbench visual evidence");
    expect(ci).toContain("/tmp/workbench-mobile-dark-dense.png");
  });

  test("focused runners bound build memory and use unambiguous Bun worker counts", () => {
    const packageBuilder = readFileSync("scripts/build-publishable-packages.ts", "utf8");
    const unitRunner = readFileSync("scripts/ci/run-unit-shard.ts", "utf8");
    const serviceRunner = readFileSync("scripts/ci/run-test-shard.ts", "utf8");
    expect(packageBuilder).toContain('NODE_OPTIONS = "--max-old-space-size=1536"');
    expect(unitRunner).toContain('"--parallel=1"');
    expect(unitRunner).toContain('OPENGENI_TEST_FILES_PER_PROCESS ?? "1"');
    expect(unitRunner).toContain(
      'const requireRealDatabase = environment.OPENGENI_REQUIRE_REAL_DB === "1"',
    );
    expect(unitRunner).toContain(
      'if (requireRealDatabase) environment.OPENGENI_REQUIRE_REAL_DB = "1"',
    );
    expect(serviceRunner).toContain('"--parallel=1"');
    expect(serviceRunner).toContain('env.OPENGENI_REQUIRE_REAL_DB = "1"');
    expect(serviceRunner).toContain('path.endsWith(".browser.e2e.ts")');
    expect(serviceRunner).toContain("needsOpe26SessionPins: selected.includes(ope26SessionPins)");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain('OPENGENI_REQUIRE_REAL_DB: "1"');
    expect(ci).toContain("needs_ope26_session_pins=$(jq -r .needsOpe26SessionPins");
    expect(ci).toContain("Upload OPE-26 session pin visual evidence");
    expect(ci).toContain("/tmp/ope26-session-pin-mobile-dark.png");
    expect(ci).toContain("--file-profile ci-profile/integration-${{ matrix.number }}-files.json");
    expect(ci).toContain("--file-profile ci-profile/e2e-${{ matrix.number }}-files.json");
    expect(serviceRunner).toContain('execution.status = "running"');
    expect(serviceRunner).toContain(
      "if (fileProfilePath) writeProfile(fileProfilePath, fileProfile)",
    );
    expect(ci).toContain(
      "integration_matrix=$(matrix \"$(jq '.integrationTests | length' impact-plan.json)\" 6)",
    );
    expect(unitRunner).not.toMatch(/"--parallel",\s*"1"/);
    expect(serviceRunner).not.toMatch(/"--parallel",\s*"1"/);
  });

  test("unit runners preserve only the explicit real-database fail-closed flag", () => {
    expect(
      sanitizedTestEnvironment({
        PATH: "/bin",
        OPENGENI_REQUIRE_REAL_DB: "1",
        OPENGENI_DATABASE_URL: "must-not-leak",
        OPENGENI_TEST_FILES_PER_PROCESS: "99",
      }),
    ).toEqual({
      PATH: "/bin",
      NODE_ENV: "test",
      OPENGENI_TEST_HERMETIC: "1",
      OPENGENI_REQUIRE_REAL_DB: "1",
    });
    expect(sanitizedTestEnvironment({ PATH: "/bin", OPENGENI_REQUIRE_REAL_DB: "true" })).toEqual({
      PATH: "/bin",
      NODE_ENV: "test",
      OPENGENI_TEST_HERMETIC: "1",
    });
  });

  test("real-service runners mark custom-suffix test files as explicit paths", () => {
    expect(explicitBunTestPath("test/integration/example.integration.ts")).toBe(
      "./test/integration/example.integration.ts",
    );
    expect(explicitBunTestPath("test/e2e/example.e2e.ts")).toBe("./test/e2e/example.e2e.ts");
    expect(explicitBunTestPath("./already-explicit.test.ts")).toBe("./already-explicit.test.ts");
  });

  test("real-service runners reject stale, missing-map, and escaping plan entries before spawn", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-stale-service-plan-"));
    const plan = join(root, "impact-plan.json");
    writeFileSync(
      plan,
      JSON.stringify({
        schemaVersion: 1,
        integrationTests: ["../../outside.integration.ts"],
        e2eTests: [],
      }),
    );
    const result = spawnSync(
      "bun",
      [
        "scripts/ci/run-test-shard.ts",
        "--plan",
        plan,
        "--tier",
        "integration",
        "--shard",
        "0",
        "--shards",
        "1",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("impact plan contains unknown integration tests");
  });
});

describe("deterministic sharding and isolation", () => {
  test("content-fenced timings separate the observed recovery-heavy critical path", () => {
    const integration = discoverTestFiles().integration;
    const profile = integrationShardWeights();
    expect(profile.mode).toBe("profile");
    expect(profile.weights?.size).toBe(integration.length);
    const shards = deterministicShards(process.cwd(), integration, 6, profile.weights ?? undefined);
    const criticalPath = "test/integration/durable-queue-control.integration.ts";
    const restartShard = shards.findIndex((files) =>
      files.includes("test/integration/worker-restart.integration.ts"),
    );
    const temporalShard = shards.findIndex((files) =>
      files.includes("test/integration/temporal-workflow.integration.ts"),
    );
    const criticalShard = shards.findIndex((files) => files.includes(criticalPath));
    expect(profile.weights?.get(criticalPath)).toBe(165_639);
    expect(profile.weights?.get("test/integration/temporal-workflow.integration.ts")).toBe(
      126_807,
    );
    expect(profile.weights?.get("test/integration/worker-restart.integration.ts")).toBe(36_286);
    expect(criticalShard).not.toBe(temporalShard);
    expect(shards[criticalShard]).toEqual([criticalPath]);
    expect(restartShard).not.toBe(temporalShard);
    expect(shards[restartShard]).toEqual([
      "test/integration/worker-restart.integration.ts",
      "test/integration/workspace-isolation.integration.ts",
    ]);
    expect(shards[temporalShard]).toEqual(["test/integration/temporal-workflow.integration.ts"]);
    const shardWeights = shards.map((files) =>
      files.reduce((total, path) => total + (profile.weights?.get(path) ?? 0), 0),
    );
    expect([...shardWeights].sort((a, b) => b - a)).toEqual([
      165_639,
      126_807,
      60_986,
      42_977,
      42_749,
      41_305,
    ]);
  });

  test("a stale or incomplete timing profile is rejected as a whole", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-shard-profile-"));
    mkdirSync(join(root, "test/integration"), { recursive: true });
    mkdirSync(join(root, "packages/testing/src"), { recursive: true });
    writeFileSync(join(root, "test/integration/a.integration.ts"), "test('a', () => {})\n");
    writeFileSync(join(root, ".bun-version"), `${Bun.version}\n`);
    writeFileSync(join(root, "packages/testing/src/service-images.ts"), "export {};\n");
    const digest = (path: string): string =>
      createHash("sha256").update(readFileSync(path)).digest("hex");
    const environment = {
      platform: process.platform,
      architecture: process.arch,
      bunVersion: Bun.version,
      bunVersionFileSha256: digest(join(root, ".bun-version")),
      serviceImagesPath: "packages/testing/src/service-images.ts",
      serviceImagesSha256: digest(join(root, "packages/testing/src/service-images.ts")),
    };
    const profilePath = join(root, "profile.json");
    writeFileSync(
      profilePath,
      JSON.stringify({
        schemaVersion: 1,
        tier: "integration",
        units: "milliseconds",
        environment,
        entries: {
          "test/integration/a.integration.ts": { sha256: "0".repeat(64), planningWeight: 10 },
        },
      }),
    );
    const stale = integrationShardWeights(root, profilePath);
    expect(stale.mode).toBe("source-bytes");
    expect(stale.weights).toBeNull();
    expect(stale.reason).toContain("stale content hash");

    writeFileSync(
      profilePath,
      JSON.stringify({
        schemaVersion: 1,
        tier: "integration",
        units: "milliseconds",
        environment,
        entries: {},
      }),
    );
    const incomplete = integrationShardWeights(root, profilePath);
    expect(incomplete.mode).toBe("source-bytes");
    expect(incomplete.weights).toBeNull();
    expect(incomplete.reason).toContain("does not exactly match");
  });

  test("the current integration projection is deterministic, exhaustive, and duplicate-free", () => {
    const integration = discoverTestFiles().integration;
    const shards = deterministicShards(process.cwd(), integration, 6);
    const assigned = shards.flat().sort();
    expect(assigned).toEqual([...integration].sort());
    expect(new Set(assigned).size).toBe(integration.length);
    expect(
      assigned.filter((path) => path === "test/integration/temporal-workflow.integration.ts"),
    ).toHaveLength(1);
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
