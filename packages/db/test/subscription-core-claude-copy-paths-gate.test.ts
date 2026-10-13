import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Merge gate for C4 (design 5.3, "C4: Claude legacy deletion"). Deleting the
// legacy Claude runtime is safe only with Claude's compat
// `dependent_sources_without_record` copy-path suite green: that suite
// proves no Claude copy path still depends on a source row the deleted
// legacy runtime used to keep. It arrives with C2b
// (packages/db/test/subscription-core-claude-copy-paths-postgres.test.ts),
// which is not stacked here yet. This ordinary test stays red until that suite
// is in the tree and names that requirement, so C4 cannot pass its
// validation, or merge, ahead of C2b. It checks presence only: at merge time
// run C2b's suite at C4's exact head on real PostgreSQL, then delete this
// gate test.
test("the Claude copy-path suite C4 depends on is in the tree", () => {
  const suite = join(import.meta.dir, "subscription-core-claude-copy-paths-postgres.test.ts");
  const present = existsSync(suite);
  expect({
    present,
    namesRequirement:
      present && readFileSync(suite, "utf8").includes("dependent_sources_without_record"),
  }).toEqual({ present: true, namesRequirement: true });
});
