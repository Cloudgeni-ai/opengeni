import { GitFailure, MergeConflict, type GitStore } from "./git";
import { bindingKey, canonical, type HeadRefresh, type Manifest, type Pull } from "./model";

/** Prove ancestry AND content. A patch-id or unchanged final diff alone is insufficient. */
export async function proveHeadRefresh(
  git: GitStore,
  manifest: Manifest,
  ready: Pull[],
  baseSha: string,
): Promise<HeadRefresh | null> {
  if (manifest.baseSha !== baseSha || manifest.predecessor !== null) return null;
  const current = manifest.pulls.map((old) => ready.find((p) => p.number === old.number));
  if (current.some((p) => !p)) return null;
  const pulls = current as Pull[];
  if (pulls.every((p, i) => bindingKey(p) === bindingKey(manifest.pulls[i]!))) return null;
  const tree = (sha: string) => git.exec(["rev-parse", `${sha}^{tree}`]);
  try {
    for (const [index, old] of manifest.pulls.entries()) {
      const next = pulls[index]!;
      if (bindingKey(old) === bindingKey(next)) continue;
      if (
        old.headSha === next.headSha ||
        old.headRef !== next.headRef ||
        old.binding.eventId !== next.binding.eventId ||
        old.binding.at !== next.binding.at ||
        old.binding.source !== next.binding.source ||
        Boolean(old.controlPlane) !== Boolean(next.controlPlane)
      )
        return null;
      let cursor = next.headSha,
        merges = 0;
      while (cursor !== old.headSha) {
        if (++merges > 8) return null;
        const parents = (await git.exec(["rev-list", "--parents", "-n", "1", cursor]))
          .split(" ")
          .slice(1);
        if (parents.length !== 2 || !(await git.ancestor(parents[1]!, baseSha))) return null;
        if ((await git.mergeTree(parents[0]!, parents[1]!)) !== (await tree(cursor))) return null;
        cursor = parents[0]!;
      }
      // Own contribution on the exact current main must remain identical.
      if (
        (await git.mergeTree(baseSha, old.headSha)) !== (await git.mergeTree(baseSha, next.headSha))
      )
        return null;
    }
    const testedTree = await tree(manifest.tipSha);
    const rebuilt = await git.build({
      schemaVersion: 1,
      baseSha,
      predecessor: manifest.predecessor,
      recoveryOf: manifest.recoveryOf,
      createdAt: manifest.createdAt,
      pulls,
    });
    if ((await tree(rebuilt.tipSha)) !== testedTree) return null;
    let tipSha = manifest.tipSha;
    const members: HeadRefresh["pulls"] = [];
    for (const [index, pull] of pulls.entries()) {
      const old = manifest.pulls[index]!;
      let mergeSha = old.mergeSha;
      if (pull.headSha !== old.headSha) {
        if ((await git.mergeTree(tipSha, pull.headSha)) !== testedTree) return null;
        tipSha = await git.commit(
          testedTree,
          [tipSha, pull.headSha],
          `Batch head refresh: PR #${pull.number}\n\nBatch-Head-Refresh: ${canonical({
            batchId: manifest.batchId,
            testedTip: manifest.tipSha,
            testedTree,
            baseSha,
            oldHead: old.headSha,
            newHead: pull.headSha,
          })}`,
          manifest.createdAt,
        );
        mergeSha = tipSha;
      }
      members.push({ ...pull, mergeSha });
    }
    return { baseSha, testedTip: manifest.tipSha, testedTree, tipSha, pulls: members };
  } catch (error) {
    // Proven composition conflict rebuilds normally; unreadable objects/errors
    // are not evidence of equivalence and must propagate to the safe read path.
    if (error instanceof MergeConflict || (error instanceof GitFailure && error.exitCode === 1))
      return null;
    throw error;
  }
}
