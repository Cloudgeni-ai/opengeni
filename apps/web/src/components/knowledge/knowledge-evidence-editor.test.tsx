import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { KnowledgeEntryRecord } from "@opengeni/sdk";
const get = mock(
  async (_workspace: string, _id: string, _options?: unknown): Promise<KnowledgeEntryRecord> => {
    throw new Error("missing");
  },
);
mock.module("@/context", () => ({ useAppContext: () => ({ client: { getKnowledgeEntry: get } }) }));
const { KnowledgeEvidenceEditor } = await import("./knowledge-evidence-editor");
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
test("reviewer compares revised source and explicitly replaces a citation without moving its old quote", async () => {
  const id = crypto.randomUUID(),
    oldId = crypto.randomUUID(),
    newId = crypto.randomUUID();
  const entry = {
    kind: "source",
    title: "Acme contract",
    content: "Thirty-day notice",
    source: { kind: "file" },
    evidence: [],
    groupIds: [],
    relationships: [],
  };
  get.mockResolvedValueOnce({
    id,
    revision: { id: oldId, number: 1, outcome: "superseded", entry },
  } as unknown as KnowledgeEntryRecord);
  get.mockResolvedValueOnce({
    id,
    revision: {
      id: newId,
      number: 2,
      outcome: "published",
      entry: { ...entry, content: "Sixty-day notice" },
    },
  } as unknown as KnowledgeEntryRecord);
  const changed = mock((_evidence: unknown) => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <KnowledgeEvidenceEditor
          workspaceId="workspace"
          disabled={false}
          evidence={[
            { entryId: id, revisionId: oldId, location: { page: 5 }, quote: "Thirty-day notice" },
          ]}
          onChange={changed}
        />,
      ),
    );
    expect(container.textContent).toContain("Thirty-day notice");
    expect(container.textContent).toContain("Sixty-day notice");
    expect(changed).not.toHaveBeenCalled();
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Use published revision",
    )!;
    await act(async () => button.click());
    expect(changed).toHaveBeenCalledWith([{ entryId: id, revisionId: newId, location: {} }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
