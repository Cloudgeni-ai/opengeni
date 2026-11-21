import { describe, expect, test } from "bun:test";
import {
  cachedSessionPullRequestDetail,
  parseGitHubPatch,
  readGitHubPullRequestDetail,
} from "../src/integrations/session-link-pull-request";

describe("a linked pull request's detail", () => {
  test("GitHub's patch text becomes numbered hunks", () => {
    const hunks = parseGitHubPatch(
      ["@@ -1,3 +1,3 @@ function a()", " keep", "-old", "+new", " tail"].join("\n"),
    );
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
    expect(hunks[0]!.header).toBe("function a()");
    expect(hunks[0]!.lines.map((line) => [line.type, line.oldNo, line.newNo, line.text])).toEqual([
      ["context", 1, 1, "keep"],
      ["del", 2, null, "old"],
      ["add", null, 2, "new"],
      ["context", 3, 3, "tail"],
    ]);
  });

  test("reads the header, files, discussion, commits and checks", async () => {
    const responses: Record<string, unknown> = {
      "/repos/acme/api/pulls/7": {
        html_url: "https://github.com/acme/api/pull/7",
        title: "Faster diffs",
        state: "open",
        draft: false,
        merged: false,
        user: { login: "ada", avatar_url: "https://x/a.png" },
        base: { ref: "main" },
        head: { ref: "fast", sha: "abc" },
        additions: 3,
        deletions: 1,
        changed_files: 2,
        commits: 1,
        comments: 1,
        mergeable: true,
        body: "Why",
      },
      "/repos/acme/api/pulls/7/files?per_page=100": [
        { filename: "a.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-a\n+b" },
        { filename: "logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
      ],
      "/repos/acme/api/pulls/7/commits?per_page=100": [
        { sha: "abc", author: { login: "ada" }, commit: { message: "Speed up", author: { date: "2026-01-01" } } },
      ],
      "/repos/acme/api/issues/7/comments?per_page=100": [
        { id: 1, user: { login: "bo" }, body: "Nice", created_at: "2026-01-02" },
      ],
      "/repos/acme/api/pulls/7/reviews?per_page=100": [
        { id: 2, user: { login: "cy" }, body: "", state: "APPROVED", submitted_at: "2026-01-03" },
        { id: 3, user: { login: "cy" }, body: "", state: "COMMENTED", submitted_at: "2026-01-04" },
      ],
      "/repos/acme/api/commits/abc/check-runs?per_page=100": {
        check_runs: [{ name: "ci", status: "completed", conclusion: "success", html_url: "https://ci" }],
      },
    };
    const read = async (path: string) => {
      if (!(path in responses)) throw new Error(`not found ${path}`);
      return responses[path];
    };
    const detail = await readGitHubPullRequestDetail(read, { owner: "acme", repo: "api", number: 7 });
    expect(detail).toMatchObject({
      title: "Faster diffs",
      state: "open",
      base: "main",
      head: "fast",
      author: { login: "ada" },
      changedFiles: 2,
      mergeable: true,
      filesTruncated: false,
    });
    expect(detail.files.map((file) => [file.path, file.status, file.isBinary])).toEqual([
      ["a.ts", "modified", false],
      ["logo.png", "added", true],
    ]);
    expect(detail.files[0]!.hunks[0]!.lines).toHaveLength(2);
    // The empty COMMENTED review is not discussion; the approval is.
    expect(detail.comments.map((comment) => [comment.kind, comment.reviewState])).toEqual([
      ["comment", null],
      ["review", "approved"],
    ]);
    expect(detail.commits).toEqual([
      { sha: "abc", message: "Speed up", author: "ada", date: "2026-01-01" },
    ]);
    // The combined status failed to read: check runs alone still report.
    expect(detail.checkRuns).toEqual([{ name: "ci", state: "passing", url: "https://ci" }]);
    expect(detail.checks).toBe("passing");
  });

  test("a merged pull request reads as merged, and the cache is per workspace", async () => {
    let reads = 0;
    const link = {
      id: "l1",
      url: "https://github.com/acme/api/pull/9",
      provider: "github",
      kind: "pull_request",
    } as never;
    const reader = async () => {
      reads += 1;
      return null;
    };
    await cachedSessionPullRequestDetail("ws-a", link, reader);
    await cachedSessionPullRequestDetail("ws-a", link, reader);
    await cachedSessionPullRequestDetail("ws-b", link, reader);
    expect(reads).toBe(2);
    const merged = await readGitHubPullRequestDetail(
      async (path) => {
        if (path === "/repos/acme/api/pulls/9") {
          return { state: "closed", merged: true, merged_at: "2026-01-05", head: {} };
        }
        throw new Error("unreadable");
      },
      { owner: "acme", repo: "api", number: 9 },
    );
    expect(merged.state).toBe("merged");
    expect(merged.files).toEqual([]);
    expect(merged.checks).toBeNull();
    expect(merged.review).toBeNull();
  });
});
