import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Pushes and pull requests made with the workflow's GITHUB_TOKEN start no
// pull_request workflows, so a PR such a workflow opens never gets PR CI and
// the merge batcher can never land it. Every workflow that opens one must
// dispatch PR CI on the exact head it pushed.
const workflowDir = resolve(import.meta.dir, "../.github/workflows");

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  permissions?: Record<string, string>;
  jobs?: Record<string, { permissions?: Record<string, string>; steps?: Step[] }>;
};

async function workflows(): Promise<[string, Workflow][]> {
  const files = (await readdir(workflowDir)).filter((file) => /\.ya?ml$/.test(file)).sort();
  return Promise.all(
    files.map(
      async (file) =>
        [file, Bun.YAML.parse(await readFile(resolve(workflowDir, file), "utf8")) as Workflow] as [
          string,
          Workflow,
        ],
    ),
  );
}

const opensPullRequestWithWorkflowToken = (step: Step) =>
  /\bgh pr create\b/.test(step.run ?? "") &&
  Object.values(step.env ?? {}).some((value) =>
    /\$\{\{\s*(github\.token|secrets\.GITHUB_TOKEN)\s*\}\}/.test(value),
  );

const dispatchesPrCi = (step: Step) =>
  /\bgh workflow run pr-ci\.yml --ref "\$branch" -f pr_number="\$number" -f head_sha="\$head_sha"/.test(
    step.run ?? "",
  ) &&
  /head_sha="\$\(git rev-parse HEAD\)"/.test(step.run ?? "") &&
  (step.run ?? "").lastIndexOf("gh workflow run pr-ci.yml") >
    (step.run ?? "").lastIndexOf("git push");

describe("pull requests opened with GITHUB_TOKEN", () => {
  test("every workflow that opens one dispatches PR CI on the exact pushed head", async () => {
    const openers: string[] = [];
    for (const [file, workflow] of await workflows()) {
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (!opensPullRequestWithWorkflowToken(step)) continue;
          openers.push(`${file}:${jobName}`);
          expect(dispatchesPrCi(step), `${file}:${jobName}`).toBe(true);
          const permissions = job.permissions ?? workflow.permissions ?? {};
          expect(permissions.actions, `${file}:${jobName}`).toBe("write");
        }
      }
    }
    expect(openers).toEqual([
      "browser-engine-pins.yml:update",
      "xai-client-version-pin.yml:update",
    ]);
  });

  test("the dispatch check rejects a step that does not dispatch PR CI after its push", () => {
    const run = [
      'git push --force origin "$branch"',
      'head_sha="$(git rev-parse HEAD)"',
      'gh pr create --base main --head "$branch"',
      'number="$(gh pr view "$branch" --json number --jq .number)"',
      'gh workflow run pr-ci.yml --ref "$branch" -f pr_number="$number" -f head_sha="$head_sha"',
    ].join("\n");
    expect(dispatchesPrCi({ run })).toBe(true);
    expect(dispatchesPrCi({ run: run.split("\n").slice(0, 3).join("\n") })).toBe(false);
    expect(dispatchesPrCi({ run: `${run}\ngit push origin other` })).toBe(false);
  });
});
