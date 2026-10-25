import { test, expect } from "bun:test";
import { GitHubAuth, GitHubReader, GitHubMutations, AutoMergePreSubmitError } from "./github";
import { config } from "./model";
import { observeCycle, observationDeferred } from "./cycle-outcome";
import { ReadUnavailable } from "./read-retry";

// Adapted from independent review probes; this pins adapter-level accounting.
// Durable executor claims remain separately conservative until reconciled.
const head = "a".repeat(40),
  parkedAt = "2026-10-24T09:00:00Z";
type Mutation = () => Response | Promise<Response>;
function rig(mutation: Mutation, opts: { tokenFail?: boolean; readErrors?: boolean } = {}) {
  const calls: string[] = [];
  const transport = (async (_url: unknown, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    calls.push(query);
    if (query.startsWith("mutation")) return mutation();
    if (opts.readErrors) return Response.json({ errors: [{ message: "fixture" }] });
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            id: "PR_1",
            headRefOid: head,
            autoMergeRequest: { enabledAt: "2026-10-24T08:00:00Z" },
          },
        },
      },
    });
  }) as typeof fetch;
  const auth = new GitHubAuth({});
  let tokenCalls = 0;
  if (opts.tokenFail)
    auth.token = async () => {
      if (++tokenCalls >= 2) throw new Error("token mint failed");
      return "";
    };
  const reader = new GitHubReader(
    config({ BATCHER_MODE: "active", BATCHER_REPOSITORY: "o/b" }),
    auth,
    transport,
  );
  return { calls, writer: new GitHubMutations(reader) };
}
async function thenFailedRead(r: ReturnType<typeof rig>) {
  const unavailable = new ReadUnavailable(502, 5, "/graphql");
  let first: unknown = null;
  await expect(
    observeCycle(async () => {
      try {
        await r.writer.disableAutoMerge(1, head, parkedAt);
      } catch (e) {
        first = e;
      }
      throw unavailable;
    }),
  ).rejects.toBe(unavailable);
  return { deferred: observationDeferred(unavailable), first };
}
for (const [name, mutation, deferred] of [
  ["transport TypeError", () => Promise.reject(new TypeError("socket")), false],
  [
    "timeout",
    () => Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
    false,
  ],
  ["HTTP 502", () => new Response("", { status: 502 }), false],
  ["HTTP 500", () => new Response("", { status: 500 }), false],
  ["200 truncated body", () => new Response('{"data":', { status: 200 }), false],
  [
    "200 mismatched id",
    () => Response.json({ data: { disablePullRequestAutoMerge: { pullRequest: { id: "PR_2" } } } }),
    false,
  ],
  ["200 null payload", () => Response.json({ data: { disablePullRequestAutoMerge: null } }), false],
  [
    "200 data+errors",
    () =>
      Response.json({
        data: { disablePullRequestAutoMerge: { pullRequest: { id: "PR_1" } } },
        errors: [{}],
      }),
    false,
  ],
  ["HTTP 422 explicit rejection", () => new Response("", { status: 422 }), true],
  ["HTTP 401 explicit rejection", () => new Response("", { status: 401 }), true],
  [
    "verified",
    () => Response.json({ data: { disablePullRequestAutoMerge: { pullRequest: { id: "PR_1" } } } }),
    true,
  ],
] as const)
  test(`disable ${name} is submitted once and preserves outcome classification`, async () => {
    const r = rig(mutation);
    const out = await thenFailedRead(r);
    expect(r.calls.filter((q) => q.startsWith("mutation"))).toHaveLength(1);
    expect(out.deferred).toBe(deferred);
    if (name !== "verified") expect(out.first).not.toBeNull();
    expect(out.first instanceof AutoMergePreSubmitError).toBe(false);
  });
test("token failure before attempt sends nothing and invents no in-cycle uncertainty", async () => {
  const r = rig(() => Response.json({}), { tokenFail: true });
  const out = await thenFailedRead(r);
  expect(r.calls.filter((q) => q.startsWith("mutation"))).toHaveLength(0);
  expect(out.deferred).toBe(true);
});
test("GraphQL-error observation is not retried and remains pre-submit", async () => {
  const r = rig(() => Response.json({}), { readErrors: true });
  const out = await thenFailedRead(r);
  expect(r.calls).toHaveLength(1);
  expect(out.first instanceof AutoMergePreSubmitError).toBe(true);
  expect(out.deferred).toBe(true);
});
test("pre-submit exhausted read preserves its cause without sending a mutation", async () => {
  let calls = 0;
  const reader = new GitHubReader(
    config({ BATCHER_MODE: "active", BATCHER_REPOSITORY: "o/b" }),
    new GitHubAuth({}),
    (async (_u: unknown, init?: RequestInit) => {
      calls++;
      expect(JSON.parse(String(init?.body)).query.startsWith("query")).toBe(true);
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch,
  );
  const error = await new GitHubMutations(reader)
    .disableAutoMerge(1, head, parkedAt)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AutoMergePreSubmitError);
  expect((error as Error).cause).toBeInstanceOf(ReadUnavailable);
  expect(calls).toBe(5);
}, 20_000);
