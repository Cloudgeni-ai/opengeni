import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestGreenMain } from "./latest-green-main";
import { fullGreenAuditBase, verifyMergeContent } from "./verify-merge-content";

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
    mkdirSync(join(cwd, "scripts/ci"), { recursive: true });
    writeFileSync(join(cwd, "scripts/ci/verify-merge-content.ts"), "// audit introduction");
    git("add", ".");
    git("commit", "-m", "introduce audit");
    const introduction = git("rev-parse", "HEAD");
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
    expect(verifyMergeContent(base, head, cwd).singleParent).toEqual([introduction, before]);
    expect(
      fullGreenAuditBase(head, cwd, () => {
        throw new Error("No successful full main CI receipt found");
      }),
    ).toBe(base);
    expect(
      fullGreenAuditBase(head, cwd, () => ({
        schemaVersion: 1,
        sha: before,
        runId: 1,
        runAttempt: 1,
        url: "test",
      })),
    ).toBe(before);
    expect(() =>
      fullGreenAuditBase(head, cwd, () => {
        throw new Error("provider unavailable");
      }),
    ).toThrow("provider unavailable");
    // Re-verifying an older head after a newer main went green: the newest
    // green run is a descendant, so the base is the newest green strict
    // ancestor, not bootstrap. Runs on a descendant or on head itself are
    // skipped before their statuses are read.
    git("commit", "--allow-empty", "-m", "later");
    const later = git("rev-parse", "HEAD");
    const statusReads: string[] = [];
    const runs = [later, head, before, base].map((sha, index) => ({
      head_sha: sha,
      id: 10 - index,
      run_attempt: 1,
      html_url: `https://example.invalid/runs/${10 - index}`,
    }));
    const greenApi = (path: string) => {
      if (path.includes("/runs?")) return { workflow_runs: runs };
      statusReads.push(path);
      const run = runs.find((candidate) => path.includes(`/commits/${candidate.head_sha}/`))!;
      return [
        {
          context: "Full CI",
          state: "success",
          target_url: `${run.html_url}/attempts/1`,
          creator: { login: "github-actions[bot]" },
        },
      ];
    };
    const discoverGreen = (accept: (sha: string) => boolean) =>
      latestGreenMain("owner/repo", greenApi, undefined, accept);
    expect(fullGreenAuditBase(head, cwd, discoverGreen)).toBe(before);
    expect(statusReads).toEqual([`repos/owner/repo/commits/${before}/statuses?per_page=100`]);
    // The newest green run on head's history still wins when it is an ancestor.
    expect(fullGreenAuditBase(later, cwd, discoverGreen)).toBe(head);
    // Only descendants and head itself are green: bootstrap, as before.
    const onlyNewer = (accept: (sha: string) => boolean) =>
      latestGreenMain(
        "owner/repo",
        (path) => (path.includes("/runs?") ? { workflow_runs: runs.slice(0, 2) } : greenApi(path)),
        undefined,
        accept,
      );
    expect(fullGreenAuditBase(head, cwd, onlyNewer)).toBe(base);
    // A discovery that ignores the filter still never yields a descendant base.
    expect(
      fullGreenAuditBase(head, cwd, () => ({
        schemaVersion: 1,
        sha: later,
        runId: 10,
        runAttempt: 1,
        url: "test",
      })),
    ).toBe(base);
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
    // A squash commit titled "(#N)" is recomputed from its parent and PR #N's head.
    const squash = git("commit-tree", `${head}^{tree}`, "-p", before, "-m", "Add pr (#7)");
    const heads = (number: number) => (number === 7 ? pr : null);
    expect(verifyMergeContent(before, squash, cwd, heads).verified).toEqual([squash]);
    expect(verifyMergeContent(before, squash, cwd, () => null).singleParent).toEqual([squash]);
    const badSquash = git("commit-tree", `${pr}^{tree}`, "-p", before, "-m", "Add pr (#7)");
    expect(() => verifyMergeContent(before, badSquash, cwd, heads)).toThrow(
      "landed merge content mismatch",
    );
    expect(() => verifyMergeContent(pr, before, cwd)).toThrow();
    expect(() => verifyMergeContent("main", head, cwd)).toThrow("exact base/head");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
