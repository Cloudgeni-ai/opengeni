import { expect, test } from "bun:test";
import type { KnowledgeEntryRecord } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { firstReviewableEntry } from "./knowledge-review-order";

function record(id: string, published = false): KnowledgeEntryRecord {
  return {
    id,
    publishedRevisionId: published ? `${id}-old` : null,
    revision: {
      id: `${id}-new`,
      outcome: published ? "published" : "pending",
      change: "upsert",
      entry: {
        title: id,
        kind: "note",
        content: id,
        evidence: [],
        groupIds: [],
        relationships: [],
      },
    },
  } as unknown as KnowledgeEntryRecord;
}
test("walks pinned pending evidence and nested collections outside the list page", async () => {
  const finding = record("finding"),
    source = record("source"),
    folder = record("folder");
  finding.revision.entry.evidence = [
    { entryId: source.id, revisionId: source.revision.id, location: {} },
  ];
  source.revision.entry.groupIds = [folder.id];
  const records = new Map([finding, source, folder].map((r) => [r.id, r]));
  const reads: string[] = [];
  const next = await firstReviewableEntry(finding.id, async (id, options) => {
    reads.push(`${id}:${options.revisionId ?? options.view ?? "published"}`);
    if (!options.view && !options.revisionId) throw new OpenGeniApiError(404, "Not published");
    return records.get(id)!;
  });
  expect(next.id).toBe("folder");
  expect(reads).toEqual([
    "finding:needs_review",
    "source:source-new",
    "source:source-new",
    "folder:published",
    "folder:needs_review",
  ]);
});
test("published collection with a pending update does not block an unrelated finding", async () => {
  const finding = record("finding"),
    folder = record("folder", true);
  finding.revision.entry.groupIds = [folder.id];
  expect(
    (await firstReviewableEntry(finding.id, async (id) => (id === finding.id ? finding : folder)))
      .id,
  ).toBe(finding.id);
});
test("detects cycles, propagates permission errors, and leaves missing links editable", async () => {
  const finding = record("finding");
  finding.revision.entry.evidence = [{ entryId: "source", revisionId: "source-new", location: {} }];
  const source = record("source");
  source.revision.entry.evidence = [
    { entryId: finding.id, revisionId: finding.revision.id, location: {} },
  ];
  await expect(
    firstReviewableEntry(finding.id, async (id) => (id === finding.id ? finding : source)),
  ).rejects.toThrow("depend on each other");
  await expect(
    firstReviewableEntry(finding.id, async (id) => {
      if (id === finding.id) return finding;
      throw new OpenGeniApiError(403, "Denied");
    }),
  ).rejects.toThrow("Denied");
  expect(
    (
      await firstReviewableEntry(finding.id, async (id) => {
        if (id === finding.id) return finding;
        throw new OpenGeniApiError(404, "Unavailable");
      })
    ).id,
  ).toBe(finding.id);
});
