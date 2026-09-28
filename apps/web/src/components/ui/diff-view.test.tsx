import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DiffView, buildDiffRows, diffLines, diffStats, diffWords } from "./diff-view";
import { RevisionHistory, previousContent, type Revision } from "./revision-history";

const BEFORE =
  "## How we work\n\n- Production changes need a second reviewer.\n- Prefer small PRs.";
const AFTER = `${BEFORE}\n- Always open pull requests as drafts.`;

describe("diffLines", () => {
  test("marks an appended rule as the only added line", () => {
    const lines = diffLines(BEFORE, AFTER);
    expect(lines.filter((line) => line.kind !== "context")).toEqual([
      { kind: "added", text: "- Always open pull requests as drafts." },
    ]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 0 });
  });

  test("puts removed lines before added ones in a changed block", () => {
    const lines = diffLines("a\nold one\nold two\nz", "a\nnew one\nz");
    expect(lines).toEqual([
      { kind: "context", text: "a" },
      { kind: "removed", text: "old one" },
      { kind: "removed", text: "old two" },
      { kind: "added", text: "new one" },
      { kind: "context", text: "z" },
    ]);
  });

  test("everything is added when there was nothing before", () => {
    expect(diffLines("", "one\ntwo")).toEqual([
      { kind: "added", text: "one" },
      { kind: "added", text: "two" },
    ]);
  });
});

describe("diffWords", () => {
  test("reconstructs both sides and groups a multi-word change", () => {
    const before = "Backups replicate to eu-west-1.";
    const after = "Backups replicate to eu-central-1 since the 1 Sep storage migration.";
    const segments = diffWords(before, after);
    const side = (drop: "added" | "removed") =>
      segments
        .filter((segment) => segment.kind !== drop)
        .map((segment) => segment.text)
        .join("");
    expect(side("added")).toBe(before);
    expect(side("removed")).toBe(after);
    expect(segments.find((segment) => segment.kind === "added")?.text).toBe(
      "eu-central-1 since the 1 Sep storage migration",
    );
    expect(segments.find((segment) => segment.kind === "removed")?.text).toBe("eu-west-1");
  });
});

describe("buildDiffRows", () => {
  const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const changed = long.map((line, index) => (index === 10 ? "line eleven" : line));

  test("keeps three lines around a change and collapses the rest", () => {
    const rows = buildDiffRows(diffLines(long.join("\n"), changed.join("\n")));
    const collapsed = rows.filter((row) => row.type === "collapsed");
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]?.type === "collapsed" && collapsed[0].lines).toHaveLength(7);
    expect(collapsed[1]?.type === "collapsed" && collapsed[1].lines).toHaveLength(6);
    const shown = rows.filter((row) => row.type === "line");
    // 3 before + removed + added + 3 after.
    expect(shown).toHaveLength(8);
  });

  test("shows everything with an infinite context", () => {
    const rows = buildDiffRows(diffLines(long.join("\n"), changed.join("\n")), Infinity);
    expect(rows.every((row) => row.type === "line")).toBe(true);
  });

  test("pairs one removed and one added line with word highlights", () => {
    const rows = buildDiffRows(diffLines("keep\nwait 30 minutes", "keep\nwait 60 minutes"));
    const removed = rows.find((row) => row.type === "line" && row.line.kind === "removed");
    expect(removed?.type === "line" && removed.words).toEqual([
      { kind: "same", text: "wait " },
      { kind: "removed", text: "30" },
      { kind: "same", text: " minutes" },
    ]);
  });
});

describe("DiffView", () => {
  test("labels changes for screen readers, not only with colour", () => {
    const html = renderToStaticMarkup(
      <DiffView before={BEFORE} after={AFTER} title="Instructions" />,
    );
    expect(html).toContain("Added: ");
    expect(html).toContain("Always open pull requests as drafts.");
    // Markdown reads as text: no "##" or "- " markers.
    expect(html).not.toContain("## How we work");
    expect(html).toContain("How we work");
  });

  test("says so when nothing changed", () => {
    const html = renderToStaticMarkup(<DiffView before={BEFORE} after={BEFORE} />);
    expect(html).toContain("No changes. This version matches the one before it.");
  });
});

describe("RevisionHistory", () => {
  const revisions: Revision[] = [
    {
      id: "2",
      author: "Bendik Hansen",
      createdLabel: "3 days ago",
      summary: "Added: Prefer small PRs.",
      content: BEFORE,
    },
    {
      id: "1",
      author: "Maria Chen",
      createdLabel: "18 Sep",
      summary: "Created the instructions",
      content: "## How we work",
    },
  ];

  test("each version is compared with the one saved before it", () => {
    expect(previousContent(revisions, 0)).toBe("## How we work");
    expect(previousContent(revisions, 1)).toBe("");
  });

  test("the newest is current; older versions offer Restore", () => {
    const html = renderToStaticMarkup(
      <RevisionHistory revisions={revisions} onRestore={() => undefined} />,
    );
    expect(html).toContain("Current");
    expect(html).toContain("Restore this version: Created the instructions");
    expect(html).not.toContain("Restore this version: Added: Prefer small PRs.");
  });

  test("explains when restoring isn't allowed", () => {
    const html = renderToStaticMarkup(
      <RevisionHistory
        revisions={revisions}
        onRestore={() => undefined}
        restoreDisabledReason="Only workspace admins can restore instructions."
      />,
    );
    expect(html).toContain("Only workspace admins can restore instructions.");
    // Still focusable so the reason can be read: aria-disabled plus a described-by reason.
    expect(html).toMatch(
      /<button[^>]*aria-label="Restore this version[^"]*"[^>]*aria-disabled="true"[^>]*aria-describedby="[^"]+"/,
    );
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Restore this version/);
  });
});
