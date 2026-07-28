import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("uses the granted workspace subject for synthetic turn execution", async () => {
  const source = await readFile(
    resolve(import.meta.dir, "operator/turn-density-profile.ts"),
    "utf8",
  );

  expect(source).toContain(
    "const profileSubjectId = `operator:turn-density-profile:${runId}`;",
  );
  expect(source.match(/subjectId: profileSubjectId/g)).toHaveLength(2);
  expect(source).not.toContain('subjectId: "turn-density-profile"');
});
