import { expect, test } from "bun:test";
import {
  KnowledgeEntryContent,
  KnowledgeEntrySaveRequest,
  knowledgeWriteDisposition,
} from "../src/knowledge-entries";

const sourceId = "00000000-0000-4000-8000-000000000001";
const revisionId = "00000000-0000-4000-8000-000000000002";
const acme = "00000000-0000-4000-8000-000000000003";
const billing = "00000000-0000-4000-8000-000000000004";

test("source content preserves full exact text beyond the old Memory limit", () => {
  const content = "  Terms\n\n" + "Acme\u0000\ud800 contract\n".repeat(500);
  const entry = KnowledgeEntryContent.parse({
    title: "Contract",
    kind: "source",
    content,
    source: { kind: "file", fileId: sourceId },
  });
  expect(entry.content).toBe(content);
});

test("one incident can link to two groups with exact evidence", () => {
  const entry = KnowledgeEntryContent.parse({
    title: "Fix reported",
    kind: "incident",
    content: "Jonas reports the fix deployed.",
    evidence: [{ entryId: sourceId, revisionId, location: { messageIds: ["41", "42"] } }],
    groupIds: [acme, billing],
  });
  expect(entry.groupIds).toEqual([acme, billing]);
  expect(entry.evidence[0]?.revisionId).toBe(revisionId);
  expect(entry.evidence[0]?.location.messageIds).toEqual(["41", "42"]);
});

test("review stages a pending write without a blocking approval result", () => {
  expect(knowledgeWriteDisposition("review_first")).toBe("pending");
  expect(knowledgeWriteDisposition("automatic")).toBe("published");
  expect(knowledgeWriteDisposition("off")).toBe("disabled");
});

test("save payload cannot override host policy or claim a personal owner", () => {
  const request = {
    operationId: sourceId,
    entryId: acme,
    expectedVersion: 0,
    entry: { title: "A fact", kind: "fact", content: "A useful fact" },
  };
  expect(KnowledgeEntrySaveRequest.safeParse({ ...request, mode: "automatic" }).success).toBe(
    false,
  );
  expect(
    KnowledgeEntrySaveRequest.safeParse({ ...request, subjectId: "someone-else" }).success,
  ).toBe(false);
});

test("empty facts, unidentifiable sources and duplicate membership are rejected", () => {
  expect(
    KnowledgeEntryContent.safeParse({ title: "Empty", kind: "fact", content: " \n" }).success,
  ).toBe(false);
  expect(
    KnowledgeEntryContent.safeParse({ title: "Source", kind: "source", content: "Text" }).success,
  ).toBe(false);
  expect(
    KnowledgeEntryContent.safeParse({
      title: "Fact",
      kind: "fact",
      content: "Text",
      groupIds: [acme, acme],
    }).success,
  ).toBe(false);
});
