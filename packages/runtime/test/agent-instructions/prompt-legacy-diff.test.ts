import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changelogDiff, legacyAllText, modularAllText, promptSentences } from "./prompt-sentences";

const CHANGELOG = readFileSync(
  join(import.meta.dir, "../../src/agent-instructions/PROMPT_CHANGELOG.md"),
  "utf8",
);

/**
 * AC13: modular "all" + opengeni renderer + every resource says what the legacy
 * contract, template, and CORE say, except the sentence edits recorded in
 * PROMPT_CHANGELOG.md. The changelog must list exactly the real difference.
 */
describe("modular prompt vs legacy prompt", () => {
  const legacy = promptSentences(legacyAllText());
  const modular = promptSentences(modularAllText());
  const listed = changelogDiff(CHANGELOG);

  test("every legacy sentence is kept or listed as removed", () => {
    const removed = [...legacy].filter((sentence) => !modular.has(sentence));
    expect(removed.sort()).toEqual([...listed.removed].sort());
  });

  test("every new sentence is listed as added", () => {
    const added = [...modular].filter((sentence) => !legacy.has(sentence));
    expect(added.sort()).toEqual([...listed.added].sort());
  });

  test("the changelog lists at least the precedence rule", () => {
    expect([...listed.added].some((sentence) => sentence.includes("take precedence"))).toBe(true);
  });
});
