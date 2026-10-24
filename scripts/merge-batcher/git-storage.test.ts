import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitStore } from "./git";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function packedBytes(dir: string) {
  let bytes = 0;
  for (const name of await readdir(join(dir, "objects/pack")))
    bytes += (await stat(join(dir, "objects/pack", name))).size;
  return bytes;
}

test("new main tips reuse fetched history across fresh processes without remote ref writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "batcher-storage-"));
  roots.push(root);
  const source = new GitStore(join(root, "source.git"));
  const destination = join(root, "cache.git");
  await source.init();
  await new GitStore(destination).init();
  await new GitStore(destination).exec(["config", "fetch.unpackLimit", "1"]);
  await new GitStore(destination).exec(["config", "gc.auto", "0"]);
  let parent: string | undefined;
  const trees: string[] = [];
  let first = 0;
  for (let n = 0; n < 8; n++) {
    const file = join(root, `blob-${n}`);
    await writeFile(file, randomBytes(65536));
    const blob = await source.exec(["hash-object", "-w", file]);
    trees.push(`100644 blob ${blob}\tfile-${n}`);
    const tree = await source.exec(["mktree"], trees.join("\n") + "\n");
    parent = await source.commit(
      tree,
      parent ? [parent] : [],
      `commit-${n}`,
      "2026-10-24T00:00:00Z",
    );
    await source.exec(["update-ref", "refs/heads/main", parent]);
    // Production starts a new child/GitStore for each cycle. Persistence must
    // come from local refs, not an in-memory list of previously fetched SHAs.
    const cache = new GitStore(destination);
    await cache.fetch(`file://${source.dir}`, [parent], "state");
    expect(await cache.exec(["rev-parse", "refs/batcher-cache/state/0"])).toBe(parent);
    if (n === 0) first = await packedBytes(destination);
  }
  expect(await packedBytes(destination)).toBeLessThan(first * 10);
  expect(await source.exec(["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
  expect(await new GitStore(destination).exec(["for-each-ref", "--format=%(refname)"])).toBe(
    "refs/batcher-cache/state/0",
  );
});

test("fetch anchors have a fixed bound and preserve exact requested object identities", async () => {
  const git = new GitStore("unused");
  let args: string[] = [];
  git.exec = async (value) => {
    args = value;
    return "";
  };
  const refs = Array.from({ length: 70 }, (_, n) => n.toString(16).padStart(40, "0"));
  await git.fetch("fixture", refs, "candidate");
  expect(args).toContain("--atomic");
  expect(args.filter((arg) => arg.includes(":refs/batcher-cache/"))).toHaveLength(64);
  expect(args).toContain(`+${refs[0]}:refs/batcher-cache/candidate/0`);
  expect(args.slice(-6)).toEqual(refs.slice(-6));
  await git.fetch("fixture", [refs[1]!], "state");
  expect(args.at(-1)).toBe(`+${refs[1]}:refs/batcher-cache/state/0`);
  await git.fetch("fixture", [refs[2]!]);
  expect(args.at(-1)).toBe(`+${refs[2]}:refs/batcher-cache/objects/0`);
});
