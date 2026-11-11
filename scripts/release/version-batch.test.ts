import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderManifest, type Manifest } from "../batcher/model";
import { versionBatchSource } from "./version-batch";

test("proves a singleton Version batch while preserving disjoint main movement", () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengeni-version-batch-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = (path: string, text: string) => {
    writeFileSync(join(cwd, path), text);
    git("add", path);
    git("commit", "-m", path);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--initial-branch=main");
    const originalBase = commit("package.json", '{"version":"1.0.0"}');
    git("checkout", "-b", "changeset-release/main");
    const head = commit("package.json", '{"version":"1.0.1"}');
    git("checkout", "main");
    const base = commit("unrelated", "main content stays");
    git("update-ref", "refs/remotes/origin/main", base);
    git("merge", "--no-ff", "changeset-release/main", "-m", "Version merge");
    const merge = git("rev-parse", "HEAD");
    const tree = git("rev-parse", "HEAD^{tree}");
    const manifest: Manifest = {
      schemaVersion: 2,
      id: "abcdef123456",
      base,
      members: [{ number: 7, title: "Version", head, tree, version: true }],
      pending: [],
    };
    const ref = `refs/heads/batch/${manifest.id}`;
    const tip = (value = manifest, tipTree = tree, parent = merge) => {
      const sha = git("commit-tree", tipTree, "-p", parent, "-m", renderManifest(value));
      git("checkout", "--detach", sha);
    };
    tip();
    expect(versionBatchSource(ref, cwd)).toEqual({ base: originalBase, head });
    expect(versionBatchSource("refs/heads/main", cwd)).toBeNull();
    expect(() => versionBatchSource("refs/heads/batch/000000000000", cwd)).toThrow("manifest");

    tip({ ...manifest, members: [{ ...manifest.members[0]!, version: undefined }] });
    expect(versionBatchSource(ref, cwd)).toBeNull();
    tip({ ...manifest, members: [...manifest.members, { ...manifest.members[0]!, number: 8 }] });
    expect(() => versionBatchSource(ref, cwd)).toThrow("sole member");
    tip({ ...manifest, base: originalBase });
    expect(() => versionBatchSource(ref, cwd)).toThrow("merge parents");
    tip(manifest, tree, head);
    expect(() => versionBatchSource(ref, cwd)).toThrow("merge parents");
    tip(manifest, git("rev-parse", `${head}^{tree}`));
    expect(() => versionBatchSource(ref, cwd)).toThrow("batch content");
    tip({
      ...manifest,
      members: [{ ...manifest.members[0]!, tree: git("rev-parse", `${head}^{tree}`) }],
    });
    expect(() => versionBatchSource(ref, cwd)).toThrow("batch content");

    // Neither a provider merge nor its manifest can hide dropped main content.
    const corruptTree = git("rev-parse", `${head}^{tree}`);
    const corruptMerge = git("commit-tree", corruptTree, "-p", base, "-p", head, "-m", "bad merge");
    tip(
      { ...manifest, members: [{ ...manifest.members[0]!, tree: corruptTree }] },
      corruptTree,
      corruptMerge,
    );
    expect(() => versionBatchSource(ref, cwd)).toThrow("batch content");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the workflow still reproduces the resolved Version head rather than skipping validation", async () => {
  const source = await Bun.file(new URL("../../.github/workflows/ci.yml", import.meta.url)).text();
  expect(source).toContain('version_batch="$(bun scripts/release/version-batch.ts)"');
  expect(source).toContain('git worktree add --detach "$expected" "$version_base_ref"');
  expect(source).toContain('actual_tree="$(git rev-parse "$version_head_ref^{tree}")"');
  expect(source).toContain('if [ "$actual_tree" != "$expected_tree" ]; then');
  expect(source).toContain('bunx changeset status --output "$plan"');
});
