import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const guardDeclarations = {
  "test:registry-dependency-exports": "bun scripts/test-registry-dependency-exports.ts",
  "test:effective-dependency-exports": "bun scripts/test-effective-dependency-exports.ts",
};
const guardHelpers = [
  "test-registry-dependency-exports.ts",
  "test-effective-dependency-exports.ts",
  "publishable-workspaces.ts",
  "rewrite-entry-points.ts",
  "rewrite-workspace-deps.ts",
  "release-publish.sh",
] as const;

type Step = {
  name?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, string | boolean>;
  uses?: string;
  if?: string;
  "working-directory"?: string;
};
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

async function workflowSteps(name: string): Promise<Step[][]> {
  const source = await readFile(join(root, ".github/workflows", name), "utf8");
  const workflow = Bun.YAML.parse(source) as Workflow;
  return Object.values(workflow.jobs).map((job) => job.steps ?? []);
}

describe("stable dependency export guard wiring", () => {
  for (const [name, expected] of [
    ["publish-packages.yml", "${{ inputs.expected_packages }}"],
    ["release.yml", "${{ steps.acceptance-bundle.outputs.expected_packages }}"],
    ["release-embedded.yml", "${{ inputs.expected_packages }}"],
  ] as const) {
    test(`${name} preserves its admitted set and reconciles before registry-only proof`, async () => {
      const jobs = await workflowSteps(name);
      const publicationJobs = jobs.filter((steps) =>
        steps.some((step) => step.with?.publish === "bun run release:publish"),
      );
      expect(publicationJobs).toHaveLength(1);
      const steps = publicationJobs[0]!;
      const publish = steps.findIndex((step) => step.with?.publish === "bun run release:publish");
      expect(steps[publish]!.env?.OPENGENI_EXPECTED_PACKAGES).toBe(expected);
      const reconciliation = steps.findIndex(
        (step, index) =>
          index > publish &&
          step.env?.OPENGENI_RELEASE_PACKAGE_PHASE === "verify" &&
          step.run?.includes("scripts/verify-release-packages.ts"),
      );
      expect(reconciliation).toBeGreaterThan(publish);
      const smoke = steps.findIndex((step) =>
        step.run?.includes("bun run test:registry-dependency-exports --candidate"),
      );
      expect(smoke).toBeGreaterThan(reconciliation);
      expect(steps[smoke]!.run).toContain(
        "bun run test:registry-dependency-exports --published-source",
      );
    });
  }

  test("shared publisher stops before manifest rewrites or publication when the guard fails", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "opengeni-publish-guard-wiring-"));
    const log = join(fixture, "calls.log");
    try {
      await writeFile(
        join(fixture, "bun"),
        `#!/usr/bin/env bash
printf '%s|%s\n' "$*" "$OPENGENI_EXPECTED_PACKAGES" >> "$GUARD_CALL_LOG"
if [[ "$*" == "run test:effective-dependency-exports" ]]; then exit 37; fi
`,
        { mode: 0o755 },
      );
      const child = Bun.spawn(["bash", join(root, "scripts/release-publish.sh")], {
        cwd: fixture,
        env: {
          ...process.env,
          PATH: `${fixture}:${process.env.PATH ?? ""}`,
          NODE_AUTH_TOKEN: "fixture-only",
          OPENGENI_EXPECTED_PACKAGES: "@opengeni/react@7.5.0,@opengeni/connect@0.3.1",
          GUARD_CALL_LOG: log,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(await child.exited).toBe(37);
      const calls = (await readFile(log, "utf8")).trim().split("\n");
      expect(calls).toEqual(
        [
          "run build:packages",
          "scripts/publish-closure-guard.ts",
          "run test:effective-dependency-exports",
        ].map((command) => `${command}|@opengeni/react@7.5.0,@opengeni/connect@0.3.1`),
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("package-contract CI includes the stable route regression", async () => {
    const jobs = await workflowSteps("ci.yml");
    expect(
      jobs
        .flat()
        .some((step) => step.run?.includes("scripts/dependency-export-workflow-contract.test.ts")),
    ).toBe(true);
  });

  test("workflow-owned regression does not replace or skip the exact candidate", async () => {
    const workflow = Bun.YAML.parse(
      await readFile(join(root, ".github/workflows/ci.yml"), "utf8"),
    ) as Workflow;
    const steps = workflow.jobs["package-contracts"]!.steps!;
    expect(steps[0]!.with?.ref).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.automation_head_sha || github.event.pull_request.head.sha || github.sha }}",
    );
    const checkout = steps.findIndex(
      (step) => step.name === "Check out registry export guard tooling",
    );
    const setup = steps.findIndex((step) => step.name === "Set up registry export guard Bun");
    const install = steps.findIndex(
      (step) => step.name === "Install registry export guard tooling dependencies",
    );
    const guard = steps.findIndex(
      (step) => step.name === "Registry dependency export guard regression",
    );
    const restore = steps.findIndex(
      (step) => step.name === "Restore candidate Bun after registry export regression",
    );
    const effective = steps.findIndex(
      (step) => step.name === "Frozen Version PR effective registry export closure",
    );
    expect(checkout).toBeGreaterThan(0);
    expect(setup).toBeGreaterThan(checkout);
    expect(install).toBeGreaterThan(setup);
    expect(guard).toBeGreaterThan(install);
    expect(restore).toBeGreaterThan(guard);
    expect(effective).toBeGreaterThan(restore);
    expect(steps[checkout]!.uses).toBe("actions/checkout@v6");
    expect(steps[checkout]!.with).toEqual({
      ref: "${{ github.workflow_sha }}",
      path: ".ci/registry-export-guard",
      "persist-credentials": false,
    });
    expect(steps[setup]!.with?.["bun-version-file"]).toBe(".ci/registry-export-guard/.bun-version");
    expect(steps[install]!["working-directory"]).toBe(".ci/registry-export-guard");
    expect(steps[install]!.run).toBe("bun install --frozen-lockfile");
    expect(steps[guard]!["working-directory"]).toBe(".ci/registry-export-guard");
    expect(steps[restore]!.with?.["bun-version-file"]).toBe(".bun-version");
    for (const index of [checkout, setup, install, guard, restore]) {
      expect(steps[index]!.if).toBeUndefined();
    }
    expect(steps[effective]!["working-directory"]).toBeUndefined();
    expect(steps[effective]!.run).toBe("bun run test:effective-dependency-exports");
  });

  test("new workflow runs real export regressions when the old candidate lacks every guard file", async () => {
    const steps = (await workflowSteps("ci.yml")).flat();
    const guard = steps.find(
      (step) => step.name === "Registry dependency export guard regression",
    )!;
    const fixture = await mkdtemp(join(tmpdir(), "opengeni-mixed-generation-guard-"));
    const candidateManifest = '{"name":"older-exact-candidate","private":true}';
    const impactPlan = '{"head":"older-exact-candidate","mode":"impact"}';
    const env = { PATH: process.env.PATH! };
    async function command(args: string[], cwd = fixture) {
      const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, status };
    }
    try {
      await writeFile(join(fixture, "package.json"), candidateManifest);
      await writeFile(join(fixture, "impact-plan.json"), impactPlan);
      expect((await command(["git", "init", "--quiet"])).status).toBe(0);
      expect((await command(["git", "add", "package.json", "impact-plan.json"])).status).toBe(0);
      expect(
        (
          await command([
            "git",
            "-c",
            "user.name=Guard Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "older exact candidate",
          ])
        ).status,
      ).toBe(0);
      const head = (await command(["git", "rev-parse", "HEAD"])).stdout;
      // This reproduces #3121: the old command fails before any tree-changing build.
      const old = await command([
        "bun",
        "test",
        "./scripts/test-registry-dependency-exports.test.ts",
        "./scripts/test-effective-dependency-exports.test.ts",
        "./scripts/dependency-export-workflow-contract.test.ts",
      ]);
      expect(old.status).not.toBe(0);
      expect(old.stderr).toContain("filters did not match any test files");
      const tooling = join(fixture, guard["working-directory"]!);
      await mkdir(join(tooling, "scripts"), { recursive: true });
      await writeFile(
        join(tooling, "package.json"),
        JSON.stringify({ scripts: guardDeclarations }),
      );
      for (const path of guardHelpers)
        await cp(join(root, "scripts", path), join(tooling, "scripts", path));
      // Run the real browser/Node and immutable-closure suites, not no-op stubs.
      // Keep this workflow-contract file out of the child to avoid recursive tests.
      for (const path of [
        "test-registry-dependency-exports.test.ts",
        "test-effective-dependency-exports.test.ts",
      ]) {
        await writeFile(
          join(tooling, "scripts", path),
          `import ${JSON.stringify(join(root, "scripts", path))};\n`,
        );
      }
      const sentinel = join(tooling, "scripts/dependency-export-workflow-contract.test.ts");
      await writeFile(
        sentinel,
        `import { test, expect } from "bun:test";\ntest("matching tooling executes", () => expect(process.cwd()).toBe(${JSON.stringify(tooling)}));\n`,
      );
      const corrected = await command(["bash", "-e", "-c", guard.run!], tooling);
      expect(corrected.status).toBe(0);
      expect(corrected.stderr).toContain(
        "browser linking rejects a missing ConnectPopupClosedError",
      );
      expect(corrected.stderr).toContain("real Node ESM linking rejects the same missing export");
      expect(corrected.stderr).toContain(
        "effective registry serves existing integrity-checked bytes",
      );
      expect(corrected.stderr).toContain("matching tooling executes");
      await unlink(sentinel);
      const incomplete = await command(["bash", "-e", "-c", guard.run!], tooling);
      expect(incomplete.status).not.toBe(0);
      expect(incomplete.stderr).toContain(
        "Missing workflow-owned guard test: scripts/dependency-export-workflow-contract.test.ts",
      );
      await writeFile(
        sentinel,
        'import { test } from "bun:test"; test("failing tooling", () => { throw new Error("GUARD_FAILURE_PROPAGATES"); });\n',
      );
      const failing = await command(["bash", "-e", "-c", guard.run!], tooling);
      expect(failing.status).not.toBe(0);
      expect(failing.stderr).toContain("GUARD_FAILURE_PROPAGATES");
      expect((await command(["git", "rev-parse", "HEAD"])).stdout).toBe(head);
      expect((await command(["git", "diff", "--name-only"])).stdout).toBe("");
      expect(await readFile(join(fixture, "package.json"), "utf8")).toBe(candidateManifest);
      expect(await readFile(join(fixture, "impact-plan.json"), "utf8")).toBe(impactPlan);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }, 60_000);
  for (const scenario of [
    {
      name: "tooling with no declarations or tests",
      declarations: 0,
      files: 0,
      missingHelper: false,
      failing: false,
      succeeds: false,
    },
    {
      name: "complete matching tooling",
      declarations: 2,
      files: 3,
      missingHelper: false,
      failing: false,
      succeeds: true,
    },
    {
      name: "declared tooling missing all tests",
      declarations: 2,
      files: 0,
      missingHelper: false,
      failing: false,
      succeeds: false,
    },
    {
      name: "declared tooling missing a test",
      declarations: 2,
      files: 2,
      missingHelper: false,
      failing: false,
      succeeds: false,
    },
    {
      name: "tests without tooling declarations",
      declarations: 0,
      files: 3,
      missingHelper: false,
      failing: false,
      succeeds: false,
    },
    {
      name: "failing guard regression",
      declarations: 2,
      files: 3,
      missingHelper: false,
      failing: true,
      succeeds: false,
    },
    {
      name: "one missing tooling declaration",
      declarations: 1,
      files: 3,
      missingHelper: false,
      failing: false,
      succeeds: false,
    },
    {
      name: "one missing tooling helper",
      declarations: 2,
      files: 3,
      missingHelper: true,
      failing: false,
      succeeds: false,
    },
  ] as const) {
    test(`workflow-owned CI enforces complete tooling for ${scenario.name}`, async () => {
      const run = (await workflowSteps("ci.yml"))
        .flat()
        .find((step) => step.name === "Registry dependency export guard regression")?.run;
      expect(run).toBeDefined();
      const fixture = await mkdtemp(join(tmpdir(), "opengeni-frozen-guard-ci-"));
      try {
        await writeFile(
          join(fixture, "package.json"),
          JSON.stringify({
            scripts: Object.fromEntries(
              Object.entries(guardDeclarations).slice(0, scenario.declarations),
            ),
          }),
        );
        await mkdir(join(fixture, "scripts"));
        for (const path of guardHelpers) {
          if (scenario.missingHelper && path === guardHelpers[0]) continue;
          await writeFile(join(fixture, "scripts", path), "// fixture helper\n");
        }
        const paths = [
          "test-registry-dependency-exports.test.ts",
          "test-effective-dependency-exports.test.ts",
          "dependency-export-workflow-contract.test.ts",
        ];
        for (const path of paths.slice(0, scenario.files)) {
          await writeFile(
            join(fixture, "scripts", path),
            `import { test, expect } from "bun:test";
            test("synthetic export guard", () => expect(${!scenario.failing}).toBe(true));`,
          );
        }
        const child = Bun.spawn(["bash", "-e", "-c", run!], {
          cwd: fixture,
          env: { PATH: process.env.PATH! },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [, errors, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(status === 0).toBe(scenario.succeeds);
        if (scenario.declarations !== 2) {
          expect(errors).toContain("Missing workflow-owned guard declaration:");
        } else if (scenario.files !== 3) {
          expect(errors).toContain("Missing workflow-owned guard test:");
        } else if (scenario.missingHelper) {
          expect(errors).toContain("Missing workflow-owned guard helper:");
        } else {
          expect(errors).toContain(scenario.failing ? "3 fail" : "3 pass");
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    });
  }
});
