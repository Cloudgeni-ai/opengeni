import { describe, expect, test } from "bun:test";
import { gitFileMode, GitHubError, isTransientGitHubFailure, RestGitHub } from "./github";

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

  test("only outages and the network count as transient", () => {
    expect(isTransientGitHubFailure(new GitHubError(503, "p", ""))).toBe(true);
    expect(isTransientGitHubFailure(new GitHubError(429, "p", ""))).toBe(true);
    expect(isTransientGitHubFailure(new GitHubError(403, "p", "API rate limit exceeded"))).toBe(
      true,
    );
    expect(isTransientGitHubFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientGitHubFailure(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isTransientGitHubFailure(new GitHubError(403, "p", "Resource not accessible"))).toBe(
      false,
    );
    expect(isTransientGitHubFailure(new GitHubError(422, "p", "Reference update failed"))).toBe(
      false,
    );
    expect(isTransientGitHubFailure(new Error("GraphQL: Something"))).toBe(false);
  });
});
