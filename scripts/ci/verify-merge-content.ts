#!/usr/bin/env bun
import { execFileSync } from "node:child_process";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Recompute each landed merge independently of the provider's merge implementation.
 * Single-parent squash commits from before queue rollout are reported, not attested.
 * This is detection after landing, not a substitute for merge_group checks.
 */
export function verifyMergeContent(base: string, head: string, cwd = process.cwd()) {
  for (const sha of [base, head]) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("expected exact base/head commit SHAs");
  }
  git(["merge-base", "--is-ancestor", base, head], cwd);
  const commits = git(["rev-list", "--first-parent", "--reverse", `${base}..${head}`], cwd)
    .split("\n")
    .filter(Boolean);
  const verified: string[] = [];
  const singleParent: string[] = [];
  for (const sha of commits) {
    const parents = git(["show", "-s", "--format=%P", sha], cwd).split(" ");
    if (parents.length === 1) {
      singleParent.push(sha);
      continue;
    }
    if (parents.length !== 2) throw new Error(`unsupported merge topology: ${sha}`);
    // merge-tree exits nonzero on conflicts. Never bless a hand-resolved tree
    // by silently accepting its changed content.
    const expected = git(["merge-tree", "--write-tree", parents[0]!, parents[1]!], cwd).split(
      "\n",
    )[0];
    const actual = git(["rev-parse", `${sha}^{tree}`], cwd);
    if (expected !== actual)
      throw new Error(`landed merge content mismatch: ${sha} expected ${expected}, got ${actual}`);
    verified.push(sha);
  }
  return { schemaVersion: 1, base, head, verified, singleParent };
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("usage: verify-merge-content.ts <before-sha> <after-sha>");
  console.log(JSON.stringify(verifyMergeContent(base, head), null, 2));
}
