import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyMergeContent } from "./verify-merge-content";

test("recomputes a merge and rejects a provider merge that silently drops earlier content", () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengeni-queue-content-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();
  try {
    git("init", "--initial-branch=main");
    writeFileSync(join(cwd, "base"), "base");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-b", "pr");
    writeFileSync(join(cwd, "pr"), "pr");
    git("add", ".");
    git("commit", "-m", "pr");
    const pr = git("rev-parse", "HEAD");
    git("checkout", "main");
    writeFileSync(join(cwd, "earlier"), "earlier");
    git("add", ".");
    git("commit", "-m", "earlier");
    const before = git("rev-parse", "HEAD");
    git("merge", "--no-ff", "pr", "-m", "queue");
    const head = git("rev-parse", "HEAD");
    expect(verifyMergeContent(before, head, cwd).verified).toEqual([head]);
    expect(verifyMergeContent(base, head, cwd).singleParent).toEqual([before]);
    const corrupt = git(
      "commit-tree",
      `${pr}^{tree}`,
      "-p",
      before,
      "-p",
      pr,
      "-m",
      "corrupt merge",
    );
    expect(() => verifyMergeContent(before, corrupt, cwd)).toThrow("landed merge content mismatch");
    expect(() => verifyMergeContent(pr, before, cwd)).toThrow();
    expect(() => verifyMergeContent("main", head, cwd)).toThrow("exact base/head");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
