import { test, expect } from "bun:test";
import { GitHubAuth, GitHubReader, GitHubMutations } from "./github";
import { config } from "./model";
import { observeCycle, observationDeferred } from "./cycle-outcome";
import { ReadUnavailable } from "./read-retry";
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
test("native request observations use bounded read recovery", async () => {
  const p = provider();
  let attempts = 0;
  const reader = new GitHubReader(p.reader.config, p.reader.auth, (async (url, init) => {
    if (++attempts === 1) return new Response("", { status: 502 });
    return p.reader.transport(url, init);
  }) as typeof fetch);
  expect((await reader.autoMergeState(1)).headSha).toBe(head);
  expect(attempts).toBe(2);
  expect(p.calls.every((q) => q.startsWith("query"))).toBe(true);
});
test("exhausted native request reads defer without invented write uncertainty", async () => {
  let attempts = 0;
  const reader = new GitHubReader(
    config({ BATCHER_MODE: "active" }),
    new GitHubAuth({}),
    (async () => {
      attempts++;
      return new Response("", { status: 502 });
    }) as unknown as typeof fetch,
  );
  let failure: unknown;
  try {
    await observeCycle(() => reader.autoMergeState(1));
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ReadUnavailable);
  expect(attempts).toBe(5);
  expect(observationDeferred(failure)).toBe(true);
}, 15_000);
for (const ambiguous of [false, true])
  test(`disable outcome ${ambiguous ? "unknown" : "verified"} is preserved across a later failed read`, async () => {
    const p = provider(head, "2026-10-24T08:00:00Z", ambiguous);
    const unavailable = new ReadUnavailable(502, 5, "/graphql");
    await expect(
      observeCycle(async () => {
        try {
          await p.writer.disableAutoMerge(1, head, parkedAt);
        } catch (error) {
          if (!ambiguous) throw error;
        }
        throw unavailable;
      }),
    ).rejects.toBe(unavailable);
    expect(p.calls.filter((q) => q.startsWith("mutation"))).toHaveLength(1);
    expect(observationDeferred(unavailable)).toBe(!ambiguous);
  });
