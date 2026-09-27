import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { KnowledgeEntryListRequest } from "@opengeni/sdk";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
let rows = true;
const listKnowledgeEntries = mock(
  async (_workspace: string, request: KnowledgeEntryListRequest) => ({
    entries:
      rows && !request.query
        ? [
            {
              id: "00000000-0000-4000-8000-000000000010",
              scope: "personal",
              version: 2,
              publishedRevisionId: "00000000-0000-4000-8000-000000000011",
              latestRevisionId: "00000000-0000-4000-8000-000000000011",
              archived: false,
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-20T00:00:00.000Z",
              excerpts: [],
              revision: {
                id: "00000000-0000-4000-8000-000000000011",
                title: "Production deploys need a second reviewer",
                kind: "decision",
                preview: "Every deploy needs a second engineer.",
                groupIds: [],
                sourceKind: null,
              },
            },
          ]
        : [],
    nextCursor: null,
  }),
);
const context = {
  client: { listKnowledgeEntries },
  captureWorkspaceInvocation: () => ({}),
  ownsWorkspaceInvocation: () => true,
};
mock.module("@/context", () => ({ useAppContext: () => context }));
const { LibraryTab, initialLibraryView } = await import("./knowledge-library");

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const opened: string[] = [];
function Harness({ fileId }: { fileId?: string }) {
  const [view, setView] = useState(initialLibraryView(false));
  return (
    <LibraryTab
      workspaceId={workspaceId}
      view={view}
      onViewChange={setView}
      {...(fileId ? { fileId } : {})}
      onClearFile={() => undefined}
      refresh={0}
      actions={{
        canEdit: () => true,
        onOpen: (entry) => opened.push(entry.id),
        onArchive: () => undefined,
        onRestore: () => undefined,
        linkFor: (entry) => `/x?entry=${entry.id}`,
      }}
      canAdd
      canUpload
      onAdd={() => undefined}
      onUpload={() => undefined}
    />
  );
}

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

test("rows open the entry's page and show a scope only when it isn't the workspace", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(listKnowledgeEntries.mock.calls.at(-1)?.[1]).toEqual({ view: "published", limit: 50 });
    expect(container.textContent).toContain("Production deploys need a second reviewer");
    expect(container.textContent).toContain("Only me");
    const row = container.querySelector<HTMLElement>("[data-slot=list-row] [data-row-action]");
    await act(async () => row!.click());
    expect(opened).toEqual(["00000000-0000-4000-8000-000000000010"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("knowledge from one file asks for supporting sources too", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness fileId="00000000-0000-4000-8000-000000000099" />));
    await settle();
    expect(listKnowledgeEntries.mock.calls.at(-1)?.[1]).toEqual({
      view: "published",
      limit: 50,
      includeEvidence: true,
      fileId: "00000000-0000-4000-8000-000000000099",
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("an empty Library explains itself with the add actions instead of a toolbar", async () => {
  rows = false;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(container.textContent).toContain("No knowledge yet");
    expect(container.textContent).toContain("Add knowledge");
    expect(container.textContent).toContain("Upload files");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    rows = true;
  }
});
