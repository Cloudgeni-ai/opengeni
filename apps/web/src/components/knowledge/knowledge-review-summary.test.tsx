import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { KnowledgeEntryRecord } from "@opengeni/sdk";
const read = mock(
  async (_workspace: string, _id: string, _options: unknown): Promise<KnowledgeEntryRecord> => old,
);
const context = { client: { getKnowledgeEntry: read } };
mock.module("@/context", () => ({ useAppContext: () => context }));
const { KnowledgeReviewSummary, changedText } = await import("./knowledge-review-summary");
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
const old = {
  id: "renewal",
  publishedRevisionId: "published",
  revision: {
    id: "published",
    number: 1,
    entry: {
      title: "Acme renewal",
      kind: "fact",
      content: "Renews at EUR 20,000 annually.",
      evidence: [],
      groupIds: [],
      relationships: [],
    },
  },
} as unknown as KnowledgeEntryRecord;
const proposed = {
  ...old,
  revision: {
    ...old.revision,
    id: "pending",
    outcome: "pending" as const,
    entry: { ...old.revision.entry, content: "Renews at EUR 21,000 annually." },
  },
};

test("shows the exact published baseline and highlights changed amounts", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(<KnowledgeReviewSummary workspaceId="workspace" record={proposed} />),
  );
  expect(read).toHaveBeenCalledWith("workspace", "renewal", { revisionId: "published" });
  expect([...container.querySelectorAll("mark")].map((node) => node.textContent)).toEqual([
    "20,000",
    "21,000",
  ]);
  expect(container.textContent).not.toContain("has been verified");
  await act(async () => root.unmount());
});
test("provenance-only changes expose exact references, revisions and full locations on demand", async () => {
  const next = {
    ...proposed,
    revision: {
      ...proposed.revision,
      entry: {
        ...old.revision.entry,
        source: {
          kind: "file" as const,
          fileId: "new-file",
          documentId: "new-document",
          sessionId: "new-chat",
          noteId: "new-note",
          externalId: "external-ref",
        },
        evidence: [
          {
            entryId: "evidence",
            revisionId: "evidence-revision",
            quote: "Evidence quote",
            location: {
              page: 2,
              path: "src/billing.ts",
              lineStart: 3,
              lineEnd: 9,
              commit: "abc123",
              passage: "Renewals",
              messageIds: ["message-1"],
            },
          },
        ],
      },
    },
  };
  read.mockImplementation(async (_workspace, id) =>
    id === "evidence"
      ? {
          ...old,
          revision: {
            ...old.revision,
            number: 7,
            entry: { ...old.revision.entry, title: "Contract" },
          },
        }
      : old,
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(<KnowledgeReviewSummary workspaceId="workspace" record={next} />),
  );
  expect(container.textContent).toContain("The text is unchanged.");
  expect(container.querySelector("details")?.open).toBe(false);
  for (const value of [
    "new-file",
    "new-document",
    "new-chat",
    "new-note",
    "external-ref",
    "Revision 7",
    "3–9",
    "abc123",
    "Renewals",
    "message-1",
  ])
    expect(container.textContent).toContain(value);
  await act(async () => root.unmount());
});
test("text comparison retains all edits, supports insertion/deletion and limits unchanged context", () => {
  for (const [before, after] of [
    ["hello", ""],
    ["", "hello"],
    ["A 💚 company", "A 💙 company"],
    ["one two three four", "ONE two three FOUR"],
  ]) {
    const diff = changedText(before!, after!);
    expect(diff.prefix + diff.before + diff.suffix).toBe(before!);
    expect(diff.prefix + diff.after + diff.suffix).toBe(after!);
  }
  const diff = changedText(
    "old ".repeat(200) + "20,000" + " end".repeat(200),
    "old ".repeat(200) + "21,000" + " end".repeat(200),
  );
  expect(diff.before).toBe("20,000");
  expect(diff.after).toBe("21,000");
  expect(diff.prefix.length + diff.suffix.length).toBeLessThan(210);
});
