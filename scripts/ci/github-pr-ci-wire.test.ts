import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrCiCommand } from "./github-pr-ci";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const old = "a".repeat(40),
  head = "b".repeat(40);
async function fixture(version = false) {
  const root = await mkdtemp(join(tmpdir(), "pr-ci-wire-"));
  roots.push(root);
  const pull = {
    number: 42,
    state: "open",
    head: {
      sha: head,
      ref: version ? "changeset-release/main" : "feature",
      repo: { full_name: "Cloudgeni-ai/opengeni" },
    },
    base: { sha: old, ref: "main" },
    user: { login: "github-actions[bot]" },
    changed_files: 1,
  };
  await Bun.write(
    join(root, "event.json"),
    JSON.stringify({ action: "synchronize", pull_request: structuredClone(pull) }),
  );
  const env = {
    GITHUB_REPOSITORY: "Cloudgeni-ai/opengeni",
    GITHUB_TOKEN: "fixture",
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_EVENT_PATH: join(root, "event.json"),
    GITHUB_OUTPUT: join(root, "out"),
    VERSION_PR_NUMBER: "42",
    VERSION_HEAD_SHA: head,
  };
  const calls: { path: string; method: string; body: any }[] = [],
    state = { pull, changeBeforeCancel: false, pullReads: 0, existingCurrent: false };
  const transport = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(String(input)),
      path = url.pathname.replace("/repos/Cloudgeni-ai/opengeni/", "");
    const method = init?.method ?? "GET",
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (method === "POST") return new Response(null, { status: 204 });
    if (path === "pulls/42") {
      state.pullReads++;
      return Response.json({
        ...pull,
        head: {
          ...pull.head,
          sha: state.changeBeforeCancel && state.pullReads > 1 ? "c".repeat(40) : pull.head.sha,
        },
      });
    }
    if (path === "pulls/42/files") return Response.json([{ filename: "docs/guide.md" }]);
    if (path === "actions/workflows/pr-ci.yml/runs")
      return Response.json({
        workflow_runs: [
          {
            id: 200,
            path: ".github/workflows/pr-ci.yml",
            event: version ? "workflow_dispatch" : "pull_request",
            head_branch: pull.head.ref,
            head_sha: old,
            status: "in_progress",
            run_attempt: 1,
            pull_requests: [{ number: 42 }],
          },
          ...(state.existingCurrent
            ? [
                {
                  id: 201,
                  path: ".github/workflows/pr-ci.yml",
                  event: "workflow_dispatch",
                  head_branch: pull.head.ref,
                  head_sha: head,
                  status: "queued",
                  run_attempt: 1,
                },
              ]
            : []),
        ],
      });
    if (path === "actions/workflows/ci.yml/runs")
      return Response.json({
        workflow_runs: [
          {
            id: 300,
            path: ".github/workflows/ci.yml",
            event: "push",
            head_branch: "main",
            head_sha: old,
            status: "in_progress",
            run_attempt: 1,
            display_title: `Version PR 42 head ${old}`,
          },
        ],
      });
    throw Error(`Unexpected API ${path}`);
  }) as typeof fetch;
  return { root, env, state, calls, transport };
}
test("superseded push cancels only observed old PR CI, not main or batch", async () => {
  const f = await fixture();
  await runPrCiCommand("superseded", f.env, f.transport);
  expect(f.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
    "actions/runs/200/cancel",
  ]);
});
test("changed head before cancellation stops without a mutation", async () => {
  const f = await fixture();
  f.state.changeBeforeCancel = true;
  await expect(runPrCiCommand("superseded", f.env, f.transport)).rejects.toThrow("Head changed");
  expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});
test("Version queue labels explicitly and dispatches exact head; existing current run deduplicates", async () => {
  for (const existing of [false, true]) {
    const f = await fixture(true);
    f.state.existingCurrent = existing;
    await runPrCiCommand("queue-version", f.env, f.transport);
    const writes = f.calls.filter((c) => c.method === "POST");
    expect(writes.find((c) => c.path === "issues/42/labels")?.body).toEqual({
      labels: ["queue-ready"],
    });
    expect(writes.some((c) => c.path === "actions/runs/300/cancel")).toBe(false);
    expect(writes.some((c) => c.path.endsWith("/dispatches"))).toBe(!existing);
    if (!existing)
      expect(writes.at(-1)?.body).toEqual({
        ref: "changeset-release/main",
        inputs: { pr_number: "42", head_sha: head },
      });
  }
});
test("incomplete file list never grants docs-only bypass", async () => {
  const f = await fixture();
  f.state.pull.changed_files = 2;
  await runPrCiCommand("identity", f.env, f.transport);
  expect(await Bun.file(join(f.root, "out")).text()).toContain("docs_only=false");
});
