import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitStore } from "./git";
import { emptyLedger } from "./model";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "batcher-blobless-"));
  roots.push(root);
  const remote = new GitStore(join(root, "remote.git"));
  await remote.init();
  await remote.exec(["config", "uploadpack.allowFilter", "true"]);
  await remote.exec(["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const make = async (text: string, parents: string[]) => {
    const blob = await remote.exec(["hash-object", "-w", "--stdin"], text);
    const tree = await remote.exec(["mktree"], `100644 blob ${blob}\tfile.txt\n`);
    return { blob, sha: await remote.commit(tree, parents, "fixture", "2026-10-24T00:00:00Z") };
  };
  const base = await make("first\nunchanged\nlast\n", []);
  const left = await make("left\nunchanged\nlast\n", [base.sha]);
  const right = await make("first\nunchanged\nright\n", [base.sha]);
  await remote.exec(["update-ref", "refs/heads/main", left.sha]);
  await remote.exec(["update-ref", "refs/heads/topic", right.sha]);
  const local = new GitStore(join(root, "local.git"));
  await local.init();
  return { remote, local, base, left, right, url: `file://${remote.dir}` };
}
test("blobless exact heads lazily retrieve merge content and preserve canonical trees", async () => {
  const f = await setup();
  await f.local.fetch(f.url, [f.left.sha, f.right.sha]);
  const missing = await f.local.exec(["rev-list", "--objects", "--missing=print", "--all"]);
  expect(missing).toContain(`?${f.left.blob}`);
  expect(await f.local.mergeTree(f.left.sha, f.right.sha)).toBe(
    await f.remote.mergeTree(f.left.sha, f.right.sha),
  );
  expect(await f.local.ancestor(f.base.sha, f.left.sha)).toBe(true);
  expect(await f.local.exec(["for-each-ref", "--format=%(refname)", "refs/tags/"])).toBe("");
  expect(await f.local.exec(["for-each-ref", "--format=%(refname)", "refs/remotes/"])).toBe("");
  await f.local.fetch(f.url, [f.left.sha, f.right.sha]);
});
test("maintenance only retires proven terminal local pins and holds unknown outcomes", async () => {
  const f = await setup();
  await f.local.fetch(f.url, [f.left.sha, f.right.sha]);
  const done = "a".repeat(64),
    active = "b".repeat(64);
  await f.local.exec(["update-ref", `refs/batcher-local/${done}`, f.left.sha]);
  await f.local.exec(["update-ref", `refs/batcher-local/${active}`, f.right.sha]);
  const ledger = emptyLedger();
  ledger.landed.push(done);
  ledger.missingRuns[active] = {
    firstSeenAt: "2026-10-24T00:00:00Z",
    updatedAt: "2026-10-24T00:00:00Z",
    status: "holding",
  };
  await f.local.maintainLocal(ledger, "2026-10-24T01:00:00Z");
  expect(await f.local.exec(["rev-parse", `refs/batcher-local/${done}`])).toBe(f.left.sha);
  ledger.missingRuns[active]!.status = "released";
  await f.local.maintainLocal(ledger, "2026-10-24T01:00:00Z");
  expect(await f.local.exec(["for-each-ref", "--format=%(refname)", "refs/batcher-local/"])).toBe(
    `refs/batcher-local/${active}`,
  );
  expect(await f.local.exec(["rev-parse", `refs/batcher-local/${active}`])).toBe(f.right.sha);
});

test("distinct forks use complete fallback and survive restart with canonical merge trees", async () => {
  const f = await setup();
  const fork = new GitStore(join(f.remote.dir, "..", "fork.git"));
  await fork.init();
  await fork.exec(["config", "uploadpack.allowFilter", "true"]);
  await fork.exec(["config", "uploadpack.allowAnySHA1InWant", "true"]);
  // A provider is complete; do not model it as another partial client whose
  // upload-pack would itself need to fetch promised blobs while serving us.
  await fork.exec(["fetch", "--no-tags", f.url, f.base.sha]);
  const blob = await fork.exec(["hash-object", "-w", "--stdin"], "first\nunchanged\nfork\n");
  const tree = await fork.exec(["mktree"], `100644 blob ${blob}\tfile.txt\n`);
  const forkHead = await fork.commit(tree, [f.base.sha], "fork", "2026-10-24T00:00:00Z");
  await fork.exec(["update-ref", "refs/heads/topic", forkHead]);
  await f.local.fetch(f.url, [f.left.sha], "state");
  await f.local.fetch(`file://${fork.dir}`, [forkHead], "candidate");
  const missing = await f.local.exec(["rev-list", "--objects", "--missing=print", "--all"]);
  expect(missing).not.toContain(`?${blob}`);
  expect(missing).toContain(`?${f.left.blob}`);
  const restarted = new GitStore(f.local.dir);
  const merged = await restarted.mergeTree(f.left.sha, forkHead);
  await f.remote.fetch(`file://${fork.dir}`, [forkHead]);
  expect(merged).toBe(await f.remote.mergeTree(f.left.sha, forkHead));
  expect(
    (await restarted.exec(["config", "--get-regexp", "remote.*.promisor"])).split("\n"),
  ).toHaveLength(1);
  await restarted.fetch(`file://${fork.dir}`, [forkHead], "candidate");
  expect(await restarted.mergeTree(f.left.sha, forkHead)).toBe(merged);
  expect(await restarted.ancestor(f.base.sha, forkHead)).toBe(true);
});

test("recovery preserves terminal pins and maintenance does not remove unrelated refs", async () => {
  const f = await setup();
  await f.local.fetch(f.url, [f.left.sha]);
  const done = "c".repeat(64);
  const terminalRef = `refs/batcher-local/${done}`;
  await f.local.exec(["update-ref", terminalRef, f.left.sha]);
  await f.local.exec(["update-ref", "refs/batcher-local/not-an-owned-id", f.left.sha]);
  await f.local.exec(["update-ref", "refs/heads/operator-evidence", f.left.sha]);
  const ledger = emptyLedger();
  ledger.landed.push(done);
  ledger.recovery.push({ batchId: done, pulls: [] });
  await f.local.maintainLocal(ledger, "2026-10-24T01:00:00Z");
  expect(await f.local.exec(["rev-parse", terminalRef])).toBe(f.left.sha);
  ledger.recovery = [];
  await f.local.maintainLocal(ledger, "2026-10-24T01:00:00Z");
  expect(await f.local.exec(["for-each-ref", "--format=%(refname)", terminalRef])).toBe("");
  expect(await f.local.exec(["rev-parse", "refs/batcher-local/not-an-owned-id"])).toBe(f.left.sha);
  expect(await f.local.exec(["rev-parse", "refs/heads/operator-evidence"])).toBe(f.left.sha);
});

test("cache slots shrink only after a successful fetch and never remove foreign refs", async () => {
  const f = await setup();
  await f.local.fetch(f.url, [f.left.sha, f.right.sha], "candidate");
  await f.local.exec(["update-ref", "refs/batcher-cache/candidate/operator", f.right.sha]);
  await expect(f.local.fetch(f.url, ["f".repeat(40)], "candidate")).rejects.toThrow();
  expect(await f.local.exec(["rev-parse", "refs/batcher-cache/candidate/1"])).toBe(f.right.sha);
  await f.local.fetch(f.url, [f.left.sha], "candidate");
  expect(
    await f.local.exec(["for-each-ref", "--format=%(refname)", "refs/batcher-cache/candidate/1"]),
  ).toBe("");
  await f.local.fetch(f.url, [], "candidate");
  expect(
    await f.local.exec(["for-each-ref", "--format=%(refname)", "refs/batcher-cache/candidate/"]),
  ).toBe("refs/batcher-cache/candidate/operator");
});

test("maintenance interval persists across process restart", async () => {
  const f = await setup();
  await f.local.fetch(f.url, [f.left.sha]);
  const ledger = emptyLedger();
  const done = "d".repeat(64);
  ledger.landed.push(done);
  await f.local.maintainLocal(ledger, "2026-10-24T01:00:00Z");
  const ref = `refs/batcher-local/${done}`;
  await f.local.exec(["update-ref", ref, f.left.sha]);
  const restarted = new GitStore(f.local.dir);
  await restarted.maintainLocal(ledger, "2026-10-24T01:01:00Z");
  expect(await restarted.exec(["rev-parse", ref])).toBe(f.left.sha);
  await restarted.maintainLocal(ledger, "2026-10-24T02:00:00Z");
  expect(await restarted.exec(["for-each-ref", "--format=%(refname)", ref])).toBe("");
});

test("providers without filter support retain exact tree correctness", async () => {
  const f = await setup();
  await f.remote.exec(["config", "uploadpack.allowFilter", "false"]);
  await f.local.fetch(f.url, [f.left.sha, f.right.sha]);
  expect(await f.local.mergeTree(f.left.sha, f.right.sha)).toBe(
    await f.remote.mergeTree(f.left.sha, f.right.sha),
  );
  expect(await f.local.exec(["rev-list", "--objects", "--missing=print", "--all"])).not.toContain(
    "?",
  );
});

for (const status of ["pending", "submitting", "uncertain", "blocked"] as const) {
  test(`maintenance preserves terminal pins with ${status} effects`, async () => {
    const f = await setup();
    await f.local.fetch(f.url, [f.left.sha]);
    const id = "e".repeat(64),
      ref = `refs/batcher-local/${id}`;
    await f.local.exec(["update-ref", ref, f.left.sha]);
    const ledger = emptyLedger();
    ledger.landed.push(id);
    ledger.effects[id] = {
      id,
      status,
      attempts: 1,
      checks: 0,
      nextAt: "2026-10-24T00:00:00Z",
      lastError: null,
      kind: "comment",
      number: 1,
      body: "retained evidence",
      marker: id,
    };
    await f.local.maintainLocal(ledger, "2026-10-24T01:00:00Z");
    expect(await f.local.exec(["rev-parse", ref])).toBe(f.left.sha);
    expect(
      await f.local.exec(["config", "--default", "0", "--get", "batcher.lastMaintenance"]),
    ).toBe("0");
  });
}
