import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("pull-request delivery process contract", () => {
  test("keeps immutable candidates distinct from moving-main compatibility", async () => {
    const [agents, skill, contributing, pullRequestTemplate, deployment] = await Promise.all([
      source("AGENTS.md"),
      source(".agents/skills/opengeni/SKILL.md"),
      source("CONTRIBUTING.md"),
      source(".github/pull_request_template.md"),
      source("docs/deployment.md"),
    ]);

    expect(agents).toContain("A protected-branch advance alone is **not** a source revision");
    expect(agents).toMatch(/verify compatibility without source\s+mutation/);
    expect(skill).toContain("do not merge or rebase `main` again merely");
    expect(skill).toContain("Base drift alone does not create a new candidate version");
    expect(contributing).toMatch(/Base-only\s+evidence refreshes stay on the same head/);
    expect(pullRequestTemplate).toContain(
      "Candidate/version labels represent substantive source changes, not base-only refreshes",
    );
    expect(deployment).toMatch(
      /Ordinary protected\s+`main` movement is not itself a candidate update/,
    );
    expect(deployment).toContain(
      "Do not merge or rebase `main` into the source branch solely to refresh",
    );
    expect(deployment).not.toContain(
      "Regenerate the body and verdict after every head or base movement",
    );
    expect(deployment.match(/--base <exact-provider-retained-pull\.base\.sha>/g)).toHaveLength(2);
    expect(deployment).toContain("the verifier's exact accepted reviewed-base identity");
    expect(deployment).toContain(
      "refresh latest-current-main\nmergeability and material-compatibility evidence",
    );
    expect(deployment).toContain("that evidence is not `reviewedBaseSha`");
    expect(deployment).not.toContain("--base <exact-current-main-sha>");
  });

  test("keeps the agent guidance aligned with executable stale-base admission", async () => {
    const [workflow, verifier, verifierTests] = await Promise.all([
      source(".github/workflows/source-admission.yml"),
      source("scripts/check-source-admission.mjs"),
      source("scripts/check-source-admission.test.ts"),
    ]);

    expect(workflow).toContain("verify_immutable_pr_head");
    expect(workflow).toContain("without requiring continuously moving main");
    expect(verifier).toContain("current main no longer retains the base-owned workflow SHA");
    expect(verifierTests).toContain(
      "admits many stale-event heads concurrently while protected main advances",
    );
  });
});
