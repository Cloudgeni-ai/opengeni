import { describe, expect, test } from "bun:test";
import {
  gitFileMode,
  GitHubError,
  GitHubNetworkError,
  isTransientGitHubFailure,
  queuedTime,
  RestGitHub,
} from "./github";
import { IN_BATCH_LABEL, QUEUE_LABEL } from "./model";

const SHA = "a".repeat(40);

/** RestGitHub against a recorded fetch that answers each request with `reply`. */
function client(reply: (request: { url: string; method: string; body: any }) => unknown) {
  const requests: { url: string; method: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const request = {
      url: String(url),
      method: String(init.method),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    return new Response(JSON.stringify(reply(request)), { status: 200 });
  }) as unknown as typeof fetch;
  return { gh: new RestGitHub("owner/repo", "token", fetchImpl), requests };
}

describe("RestGitHub file and branch writes", () => {
  test("file modes are Git's octal strings", () => {
    expect(gitFileMode(33188)).toBe("100644");
    expect(gitFileMode(33261)).toBe("100755");
    expect(gitFileMode(40960)).toBe("120000");
  });

  test("readFiles reads blobs and modes at one commit, with paths only in variables", async () => {
    const { gh, requests } = client(({ body }) => {
      const data: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body.variables)) {
        if (key === "f0")
          data.f0 = { oid: "o0", text: "select 1;\n", isBinary: false, isTruncated: false };
        if (key === "f1") data.f1 = { oid: "o1", text: null, isBinary: true, isTruncated: false };
        if (key === "f2") data.f2 = null;
        if (key.startsWith("d"))
          data[key] = String(value).endsWith(":db")
            ? {
                entries: [
                  { name: "0007_b.sql", mode: 33188, type: "blob" },
                  { name: "run.sh", mode: 33261, type: "blob" },
                ],
              }
            : null;
      }
      return { data: { repository: data } };
    });
    const files = await gh.readFiles(SHA, ["db/0007_b.sql", "db/run.sh", "db/gone.sql"]);
    expect([...files]).toEqual([
      ["db/0007_b.sql", { oid: "o0", mode: "100644", text: "select 1;\n" }],
      ["db/run.sh", { oid: "o1", mode: "100755", text: null }],
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.variables).toMatchObject({
      owner: "owner",
      name: "repo",
      f0: `${SHA}:db/0007_b.sql`,
      d0: `${SHA}:db`,
    });
    expect(requests[0]!.body.query).not.toContain("0007_b");
    await expect(gh.readFiles("main", ["db/0007_b.sql"])).rejects.toThrow("Not a commit SHA");
  });

  test("readFiles reads a text blob GraphQL truncated through the blob API", async () => {
    const whole = "export * from './a';\n".repeat(40_000);
    const { gh, requests } = client(({ url, body }) => {
      if (url.endsWith("/git/blobs/big"))
        return { content: Buffer.from(whole).toString("base64"), encoding: "base64" };
      if (url.endsWith("/git/blobs/bad"))
        return { content: Buffer.from([0xff, 0xfe, 0x00]).toString("base64"), encoding: "base64" };
      const data: Record<string, unknown> = {};
      for (const key of Object.keys(body.variables)) {
        if (key === "f0")
          data.f0 = { oid: "big", text: whole.slice(0, 100), isBinary: false, isTruncated: true };
        if (key === "f1") data.f1 = { oid: "bad", text: "x", isBinary: false, isTruncated: true };
        if (key.startsWith("d"))
          data[key] = {
            entries: [
              { name: "index.ts", mode: 33188, type: "blob" },
              { name: "odd.ts", mode: 33188, type: "blob" },
            ],
          };
      }
      return { data: { repository: data } };
    });
    const files = await gh.readFiles(SHA, ["src/index.ts", "src/odd.ts"]);
    expect(files.get("src/index.ts")).toEqual({ oid: "big", mode: "100644", text: whole });
    expect(files.get("src/odd.ts")).toEqual({ oid: "bad", mode: "100644", text: null });
    expect(requests.map((r) => r.method)).toEqual(["POST", "GET", "GET"]);
  });

  test("createTree adds blobs on a base tree, and updateBranch never forces", async () => {
    const { gh, requests } = client(() => ({ sha: "t".repeat(40) }));
    expect(
      await gh.createTree("b".repeat(40), [
        { path: "db/0007_b.sql", mode: "100644", sha: null },
        { path: "db/0008_b.sql", mode: "100755", content: "x" },
      ]),
    ).toBe("t".repeat(40));
    await gh.updateBranch("feature/a b", SHA);
    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/owner/repo/git/trees",
        method: "POST",
        body: {
          base_tree: "b".repeat(40),
          tree: [
            { path: "db/0007_b.sql", mode: "100644", sha: null, type: "blob" },
            { path: "db/0008_b.sql", mode: "100755", content: "x", type: "blob" },
          ],
        },
      },
      {
        url: "https://api.github.com/repos/owner/repo/git/refs/heads/feature/a%20b",
        method: "PATCH",
        body: { sha: SHA, force: false },
      },
    ]);
  });

  test("branchHead reads exactly one branch, whose name never changes the request path", async () => {
    const requests: string[] = [];
    const fetchImpl = (async (url: string) => {
      requests.push(String(url));
      return String(url).endsWith("/gone")
        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
        : new Response(JSON.stringify({ object: { sha: SHA } }), { status: 200 });
    }) as unknown as typeof fetch;
    const gh = new RestGitHub("owner/repo", "token", fetchImpl);
    expect(await gh.branchHead("x/%2e%2e/%2e%2e/user")).toBe(SHA);
    expect(await gh.branchHead("gone")).toBeNull();
    expect(requests).toEqual([
      "https://api.github.com/repos/owner/repo/git/ref/heads/x/%252e%252e/%252e%252e/user",
      "https://api.github.com/repos/owner/repo/git/ref/heads/gone",
    ]);
    // The encoded name stays inside the repository's refs once the URL is parsed.
    expect(new URL(requests[0]!).pathname).toBe(
      "/repos/owner/repo/git/ref/heads/x/%252e%252e/%252e%252e/user",
    );
  });

  test("only outages and requests with no answer count as transient", async () => {
    expect(isTransientGitHubFailure(new GitHubError(503, "p", ""))).toBe(true);
    expect(isTransientGitHubFailure(new GitHubError(429, "p", ""))).toBe(true);
    expect(isTransientGitHubFailure(new GitHubError(403, "p", "API rate limit exceeded"))).toBe(
      true,
    );
    // A rejected fetch (network failure or timeout) becomes a GitHubNetworkError.
    for (const failure of [
      new TypeError("fetch failed"),
      new DOMException("timed out", "TimeoutError"),
    ]) {
      const gh = new RestGitHub("owner/repo", "token", (async () => {
        throw failure;
      }) as unknown as typeof fetch);
      const error = await gh.branchHead("main").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitHubNetworkError);
      expect(isTransientGitHubFailure(error)).toBe(true);
    }
    // The same error types from our own code are bugs, not outages.
    expect(isTransientGitHubFailure(new TypeError("Cannot read properties of null"))).toBe(false);
    expect(isTransientGitHubFailure(new DOMException("timed out", "TimeoutError"))).toBe(false);
    expect(isTransientGitHubFailure(new GitHubError(403, "p", "Resource not accessible"))).toBe(
      false,
    );
    expect(isTransientGitHubFailure(new GitHubError(422, "p", "Reference update failed"))).toBe(
      false,
    );
    expect(isTransientGitHubFailure(new Error("GraphQL: Something"))).toBe(false);
  });
});

describe("RestGitHub comments", () => {
  test("commentBodies reads every comment since a time, page by page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ body: `c${i}` }));
    const { gh, requests } = client(({ url }) =>
      url.endsWith("page=1") ? full : [{ body: null }, { body: "<!-- marker -->" }],
    );
    const bodies = await gh.commentBodies(7, Date.UTC(2026, 9, 30, 12, 0, 0));
    expect(bodies).toHaveLength(102);
    expect(bodies.slice(-2)).toEqual(["", "<!-- marker -->"]);
    expect(requests.map((r) => r.url.replace(/^.*\/repos\/owner\/repo\//, ""))).toEqual([
      "issues/7/comments?since=2026-10-30T12%3A00%3A00.000Z&per_page=100&page=1",
      "issues/7/comments?since=2026-10-30T12%3A00%3A00.000Z&per_page=100&page=2",
    ]);
  });
});

describe("RestGitHub compare", () => {
  test("compareFiles keeps the merge base when there are too many files to list", async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` }));
    const { gh } = client(() => ({ merge_base_commit: { sha: "b".repeat(40) }, files: many }));
    expect(await gh.compareFiles("a".repeat(40), "c".repeat(40))).toEqual({
      files: null,
      mergeBase: "b".repeat(40),
    });
  });

  test("compareFiles lists renamed files under both names", async () => {
    const { gh } = client(() => ({
      merge_base_commit: { sha: "b".repeat(40) },
      files: [{ filename: "new.ts", previous_filename: "old.ts" }, { filename: "x.ts" }],
    }));
    expect(await gh.compareFiles("a".repeat(40), "c".repeat(40))).toEqual({
      files: ["new.ts", "old.ts", "x.ts"],
      mergeBase: "b".repeat(40),
    });
  });
});

const event = (name: string, at: string) => ({ createdAt: at, label: { name } });

describe("queuedTime", () => {
  test("is the latest time the queue label was added", () => {
    const events = [
      event(QUEUE_LABEL, "2026-10-30T10:00:00Z"),
      event(IN_BATCH_LABEL, "2026-10-30T10:05:00Z"),
      event(QUEUE_LABEL, "2026-10-30T11:00:00Z"),
      null,
    ];
    expect(queuedTime(events, QUEUE_LABEL)).toBe(Date.parse("2026-10-30T11:00:00Z"));
  });

  test("keeps a PR queued when other labels pushed its queue event out of the window", () => {
    const events = [
      event(IN_BATCH_LABEL, "2026-10-30T12:00:00Z"),
      event(IN_BATCH_LABEL, "2026-10-30T12:30:00Z"),
    ];
    expect(queuedTime(events, QUEUE_LABEL)).toBe(Date.parse("2026-10-30T12:00:00Z"));
    expect(queuedTime([], QUEUE_LABEL)).toBe(0);
  });
});
