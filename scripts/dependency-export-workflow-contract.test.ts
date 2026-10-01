import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

type Step = {
  name?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, string>;
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

  for (const scenario of [
    { name: "older frozen source", declared: false, files: 0, failing: false, succeeds: true },
    { name: "complete current guard", declared: true, files: 3, failing: false, succeeds: true },
    {
      name: "declared guard missing all tests",
      declared: true,
      files: 0,
      failing: false,
      succeeds: false,
    },
    {
      name: "declared guard missing a test",
      declared: true,
      files: 2,
      failing: false,
      succeeds: false,
    },
    {
      name: "tests without the declared guard",
      declared: false,
      files: 3,
      failing: false,
      succeeds: false,
    },
    { name: "failing guard regression", declared: true, files: 3, failing: true, succeeds: false },
  ] as const) {
    test(`exact-source CI handles ${scenario.name}`, async () => {
      const run = (await workflowSteps("ci.yml"))
        .flat()
        .find((step) => step.name === "Registry dependency export guard regression")?.run;
      expect(run).toBeDefined();
      const fixture = await mkdtemp(join(tmpdir(), "opengeni-frozen-guard-ci-"));
      try {
        await writeFile(
          join(fixture, "package.json"),
          JSON.stringify({
            scripts: scenario.declared ? { "test:effective-dependency-exports": "fixture" } : {},
          }),
        );
        await mkdir(join(fixture, "scripts"));
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
        const [output, errors, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(status === 0).toBe(scenario.succeeds);
        if (!scenario.declared && scenario.files === 0) {
          expect(output).toContain("not part of this selected source revision");
        } else if (!scenario.declared || scenario.files !== 3) {
          expect(errors).toContain("Registry export guard source is incomplete");
        } else {
          expect(errors).toContain(scenario.failing ? "3 fail" : "3 pass");
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    });
  }
});
