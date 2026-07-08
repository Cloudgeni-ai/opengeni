/* ----------------------------------------------------------------------------
   D3 — ONE diff renderer. After Workbench v2 the hand-rolled hunk renderer is
   gone: `diff-view.tsx` is a thin `@deprecated` alias over `PierreDiff`, and no
   workbench component imports a second hunk renderer. A grep-test (source, not
   runtime) so a regression that re-adds a parallel renderer fails CI.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

describe("D3: one diff renderer", () => {
  test("diff-view.tsx is a deprecated alias with NO hand-rolled hunk renderer", () => {
    const code = src("components/diff-view.tsx");
    expect(code).toContain("@deprecated");
    expect(code).toContain("PierreDiff");
    // The removed hand-rolled renderer's building blocks must be gone.
    for (const gone of ["function FileDiffBlock", "function UnifiedHunks", "function SplitHunks", "data-opengeni-diff"]) {
      expect(code).not.toContain(gone);
    }
  });

  test("no workbench component imports the diff-view module", () => {
    const workbenchPaths = [
      "components/sandbox-files.tsx",
      "components/workbench-changes.tsx",
      "components/sandbox-workspace.tsx",
      "timeline/tool-diff.tsx",
    ];
    for (const path of workbenchPaths) {
      const code = src(path);
      expect(code).not.toMatch(/from\s+["'][^"']*diff-view["']/);
    }
  });

  test("the hand-rolled hunk-renderer marker exists nowhere in the source", () => {
    // `data-opengeni-diff` was the hand-rolled renderer's DOM marker; only the
    // Pierre marker (`data-opengeni-pierre-diff`) should remain.
    for (const path of [
      "components/diff-view.tsx",
      "components/pierre-diff.tsx",
      "components/sandbox-files.tsx",
      "components/workbench-changes.tsx",
    ]) {
      expect(src(path)).not.toContain('data-opengeni-diff"');
    }
    expect(src("components/pierre-diff.tsx")).toContain("data-opengeni-pierre-diff");
  });
});
