import { execFileSync } from "node:child_process";
import { BATCH_PREFIX, parseManifest } from "../batcher/model";

/** Resolve the original Version tree only after proving the complete batch tree.
 * The ordinary deterministic generator check still reproduces that Version head.
 * Disjoint main movement is preserved by independently recomputing its merge. */
export function versionBatchSource(ref: string, cwd = process.cwd()) {
  if (!ref.startsWith(`refs/heads/${BATCH_PREFIX}`)) return null;
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const fail = (reason: string): never => {
    throw new Error(`Invalid Version batch: ${reason}`);
  };
  const parents = (sha: string) => git("show", "-s", "--format=%P", sha).split(" ");
  const tree = (sha: string) => git("rev-parse", `${sha}^{tree}`);
  const manifest = parseManifest(git("show", "-s", "--format=%B", "HEAD"));
  if (!manifest || ref !== `refs/heads/${BATCH_PREFIX}${manifest.id}`)
    return fail("manifest does not match its branch");
  if (!manifest.members.some((member) => member.version)) return null;
  const member = manifest.members[0]!;
  if (manifest.members.length !== 1 || member.version !== true)
    return fail("Version PR must be the sole member");
  const tipParents = parents("HEAD");
  if (tipParents.length !== 1) return fail("manifest tip must have one merge parent");
  const merge = tipParents[0]!;
  const mergeParents = parents(merge);
  if (
    mergeParents.length !== 2 ||
    mergeParents[0] !== manifest.base ||
    mergeParents[1] !== member.head
  )
    return fail("merge parents differ from the manifest");
  const versionParents = parents(member.head);
  if (versionParents.length !== 1) return fail("Version head must have one base parent");
  const base = versionParents[0]!;
  git("merge-base", "--is-ancestor", manifest.base, "refs/remotes/origin/main");
  if (git("merge-base", manifest.base, member.head) !== base)
    return fail("Version base is not the merge base");
  const expected = git("merge-tree", "--write-tree", manifest.base, member.head).split("\n")[0];
  if (tree("HEAD") !== expected || tree(merge) !== expected || member.tree !== expected)
    return fail("batch content differs from the recomputed Version merge");
  return { base, head: member.head };
}

if (import.meta.main) console.log(JSON.stringify(versionBatchSource(process.env.GITHUB_REF ?? "")));
