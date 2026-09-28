import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("canary checkout admits the frozen main ancestor and rejects an unrelated commit", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL("../.github/workflows/publish-canary.yml", import.meta.url), "utf8"),
  ) as { jobs: { publish: { steps: { name?: string; run?: string }[] } } };
  const script = workflow.jobs.publish.steps.find(
    (step) => step.name === "Verify exact source",
  )!.run!;
  const cwd = mkdtempSync(join(tmpdir(), "canary-source-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-m", "frozen candidate");
    const source = git("rev-parse", "HEAD");
    git("checkout", "-b", "unmerged");
    git("commit", "--allow-empty", "-m", "unmerged source");
    const unrelated = git("rev-parse", "HEAD");
    git("checkout", "main");
    git("commit", "--allow-empty", "-m", "new controller");
    const controller = git("rev-parse", "HEAD");
    for (const candidate of [source, controller, unrelated]) {
      git("checkout", "--detach", controller);
      const result = spawnSync("bash", ["-c", script], {
        cwd,
        env: { ...process.env, SOURCE_SHA: candidate },
        encoding: "utf8",
      });
      expect(result.status === 0).toBe(candidate !== unrelated);
      expect(git("rev-parse", "HEAD")).toBe(candidate === unrelated ? controller : candidate);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
