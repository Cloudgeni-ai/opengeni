import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  changelogDiff,
  legacyAllText,
  modularAllText,
  PROMPT_CHANGELOG_DIR,
  PROMPT_CHANGELOG_ENTRY_NAME,
  promptChangelogDiff,
  promptChangelogFiles,
  promptSentences,
} from "./prompt-sentences";

/**
 * AC13: modular "all" + opengeni renderer + every resource says what the legacy
 * contract, template, and CORE say, except the sentence edits recorded in
 * the prompt changelog entry files (`agent-instructions/prompt-changelog/`).
 * The union of their `diff` lines must list exactly the real difference.
 */
describe("modular prompt vs legacy prompt", () => {
  const legacy = promptSentences(legacyAllText());
  const modular = promptSentences(modularAllText());
  const listed = promptChangelogDiff();

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

describe("prompt changelog layout", () => {
  test("entries are one file per change, named <YYYY-MM-DD>-<slug>.md", () => {
    const misnamed = promptChangelogFiles().filter(
      (name) =>
        name !== "README.md" &&
        (!PROMPT_CHANGELOG_ENTRY_NAME.test(name) ||
          !statSync(join(PROMPT_CHANGELOG_DIR, name)).isFile()),
    );
    expect(misnamed).toEqual([]);
  });

  test("the README holds no sentence edits", () => {
    const readme = changelogDiff(readFileSync(join(PROMPT_CHANGELOG_DIR, "README.md"), "utf8"));
    expect([...readme.removed, ...readme.added]).toEqual([]);
  });

  test("the old single PROMPT_CHANGELOG.md stays retired", () => {
    // A PR branched before the split re-adds it when resolving its conflict;
    // move its paragraph and diff lines into a new entry file instead.
    expect(existsSync(join(PROMPT_CHANGELOG_DIR, "../PROMPT_CHANGELOG.md"))).toBe(false);
  });
});
