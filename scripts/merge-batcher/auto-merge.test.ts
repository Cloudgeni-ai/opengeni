import { test, expect } from "bun:test";
import { GitHubAuth, GitHubReader, GitHubMutations } from "./github";
import { config } from "./model";
const head = "a".repeat(40),
  parkedAt = "2026-10-24T09:00:00Z";
function provider(headSha = head, enabledAt: string | null = "2026-10-24T08:00:00Z", fail = false) {
  const calls: string[] = [];
  const transport = (async (_url: unknown, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    calls.push(query);
    if (query.startsWith("mutation")) {
      if (fail) return Response.json({ errors: [{ message: "fixture rejection" }] });
      return Response.json({
        data: { disablePullRequestAutoMerge: { pullRequest: { id: "PR_1" } } },
      });
    }
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            id: "PR_1",
            headRefOid: headSha,
            autoMergeRequest: enabledAt === null ? null : { enabledAt },
          },
        },
      },
    });
  }) as typeof fetch;
  const reader = new GitHubReader(
    config({ BATCHER_MODE: "active", BATCHER_REPOSITORY: "owner/base" }),
    new GitHubAuth({}),
    transport,
  );
  return { calls, reader, writer: new GitHubMutations(reader) };
}
test("park disables the observed native request on the exact head", async () => {
  const p = provider();
  await p.writer.disableAutoMerge(1, head, parkedAt);
  expect(p.calls.filter((q) => q.startsWith("mutation"))).toHaveLength(1);
});
for (const [name, sha, at] of [
  ["changed head", "b".repeat(40), "2026-10-24T08:00:00Z"],
  ["new enable", head, "2026-10-24T09:01:00Z"],
  ["already disabled", head, null],
] as const)
  test(`park preserves ${name}`, async () => {
    const p = provider(sha, at);
    await p.writer.disableAutoMerge(1, head, parkedAt);
    expect(p.calls.filter((q) => q.startsWith("mutation"))).toHaveLength(0);
  });
test("GraphQL errors are not accepted as successful disable", async () => {
  const p = provider(head, "2026-10-24T08:00:00Z", true);
  await expect(p.writer.disableAutoMerge(1, head, parkedAt)).rejects.toThrow("unverified");
});
