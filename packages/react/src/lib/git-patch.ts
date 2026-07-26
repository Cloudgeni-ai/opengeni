import type { GitFileDiff } from "@opengeni/sdk";

/**
 * Reconstruct a unified-diff patch string for a single `GitFileDiff` so it can
 * be fed to a generic patch renderer (e.g. Pierre's `PatchDiff`). The hook
 * already carries per-line old/new numbers and a hunk header, so we emit a
 * conventional `--- / +++ / @@` patch the parser understands.
 */
export function gitFileDiffToPatch(file: GitFileDiff): string {
  const oldPath = file.oldPath ?? file.path;
  const newPath = file.path;
  const lines: string[] = [];
  lines.push(`diff --git a/${oldPath} b/${newPath}`);
  if (file.status === "deleted") {
    lines.push(`--- a/${oldPath}`);
    lines.push(`+++ /dev/null`);
  } else if (file.status === "added" || file.status === "untracked") {
    lines.push(`--- /dev/null`);
    lines.push(`+++ b/${newPath}`);
  } else {
    lines.push(`--- a/${oldPath}`);
    lines.push(`+++ b/${newPath}`);
  }
  for (const hunk of file.hunks) {
    // Only trust a pre-parsed header if it carries the full unified range form
    // `@@ -<o>[,<n>] +<o>[,<n>] @@`. A synthesized create_file hunk (parsers.ts)
    // can carry a degenerate `@@ +1 @@` with no `-`/`+` ranges; a generic patch
    // parser (Pierre) renders zero lines from it, so the expanded diff comes up
    // empty while the collapsed chip still shows the (correct) addition count.
    // In that case regenerate a valid header from the hunk's range fields.
    const headerIsValid = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(hunk.header ?? "");
    const header = headerIsValid
      ? hunk.header
      : `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    lines.push(header);
    for (const line of hunk.lines) {
      if (line.type === "meta") continue;
      const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
      lines.push(`${prefix}${line.text}`);
    }
  }
  return lines.join("\n") + "\n";
}
