import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { KnowledgeEntryListRequest } from "@opengeni/sdk";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
let rows = true;
let tree = false;
let nextCursor: string | null = null;

const RUNBOOKS = "00000000-0000-4000-8000-000000000020";
const PAYMENTS = "00000000-0000-4000-8000-000000000021";
function summary(id: string, title: string, kind: string, groupIds: string[] = []) {
  return {
    id,
    scope: "workspace",
    version: 1,
    publishedRevisionId: `${id.slice(0, -3)}999`,
    latestRevisionId: `${id.slice(0, -3)}999`,
    archived: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    excerpts: [],
    revision: {
      id: `${id.slice(0, -3)}999`,
      title,
      kind,
      preview: "",
      groupIds,
      sourceKind: null,
    },
  };
}
// Runbooks > Payments, one entry directly in Runbooks and one loose entry.
function treeEntries(request: KnowledgeEntryListRequest) {
  const runbooks = summary(RUNBOOKS, "Runbooks", "group");
  const payments = summary(PAYMENTS, "Payments", "group", [RUNBOOKS]);
  const rollback = summary(
    "00000000-0000-4000-8000-000000000022",
    "Rolling back a bad deploy",
    "decision",
    [RUNBOOKS],
  );
  const loose = summary("00000000-0000-4000-8000-000000000023", "Loose fact", "fact");
  if (request.groupId === RUNBOOKS)
    return request.kind === "group" ? [payments] : [rollback, payments];
  if (request.groupId === PAYMENTS) return [];
  if (request.rootOnly) return request.kind === "group" ? [runbooks] : [runbooks, loose];
  return [runbooks, payments, rollback, loose];
}

const listKnowledgeEntries = mock(
  async (_workspace: string, request: KnowledgeEntryListRequest) => ({
    entries: tree
      ? treeEntries(request)
      : rows && !request.query
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
    nextCursor,
  }),
);
const context = {
  client: { listKnowledgeEntries },
  captureWorkspaceInvocation: () => ({}),
  ownsWorkspaceInvocation: () => true,
};
mock.module("@/context", () => ({ useAppContext: () => context }));
const { LibraryTab, initialLibraryView, knowledgeAddedSince } = await import("./knowledge-library");

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const opened: string[] = [];
function Harness({
  fileId,
  collections,
  added,
}: {
  fileId?: string;
  collections?: boolean;
  added?: string;
}) {
  const [view, setView] = useState({
    ...initialLibraryView(false),
    ...(collections ? { layout: "collections" as const } : {}),
    ...(added ? { filters: { added: [added] } } : {}),
  });
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

test("Added windows use exact elapsed days and ignore unknown options", () => {
  const now = Date.parse("2026-10-06T08:15:00.000Z");
  expect(knowledgeAddedSince("day", now)).toBe("2026-10-05T08:15:00.000Z");
  expect(knowledgeAddedSince("week", now)).toBe("2026-09-29T08:15:00.000Z");
  expect(knowledgeAddedSince("month", now)).toBe("2026-09-06T08:15:00.000Z");
  expect(knowledgeAddedSince(undefined, now)).toBeUndefined();
  expect(knowledgeAddedSince("unknown", now)).toBeUndefined();
});

test("Added is server-side, survives pagination and scope changes, and can be removed", async () => {
  nextCursor = "next-page";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const started = Date.now();
  try {
    await act(async () => root.render(<Harness collections added="week" />));
    await settle();
    const first = listKnowledgeEntries.mock.calls.at(-1)![1];
    expect(first.view).toBe("published");
    expect(first.limit).toBe(50);
    expect(first.rootOnly).toBeUndefined();
    expect(first.createdSince).toBeDefined();
    const cutoff = Date.parse(first.createdSince!);
    expect(cutoff).toBeGreaterThanOrEqual(started - 7 * 86400000);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - 7 * 86400000);
    expect(container.textContent).toContain("Added:Last 7 days");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    const button = (text: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent === text,
      )!;
    await act(async () => button("Load more").click());
    await settle();
    expect(listKnowledgeEntries.mock.calls.at(-1)![1]).toEqual({
      ...first,
      cursor: "next-page",
    });
    await act(async () => button("Workspace").click());
    await settle();
    expect(listKnowledgeEntries.mock.calls.at(-1)![1]).toEqual({ ...first, scope: "workspace" });
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove filter Added: Last 7 days"]',
    )!;
    await act(async () => remove.click());
    await settle();
    // Removing the only filter restores the requested collection layout.
    expect(listKnowledgeEntries.mock.calls.at(-1)![1].createdSince).toBeUndefined();
    expect(container.textContent).not.toContain("Added:Last 7 days");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    nextCursor = null;
  }
});

test("Added collection dates use creation time without an Edited label", async () => {
  tree = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness added="week" />));
    await settle();
    const date = () => container.querySelector("[data-slot=relative-time]")!;
    expect(container.textContent).toContain("Runbooks");
    expect(date().getAttribute("datetime")).toBe("2026-09-01T00:00:00.000Z");
    expect(date().textContent).not.toStartWith("Edited ");
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove filter Added: Last 7 days"]',
    )!;
    await act(async () => remove.click());
    await settle();
    expect(date().getAttribute("datetime")).toBe("2026-09-20T00:00:00.000Z");
    expect(date().textContent).toStartWith("Edited ");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    tree = false;
  }
});

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

test("By collection shows only top-level collections, sub-collections first as rows", async () => {
  tree = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness collections />));
    await settle();
    const sections = [...container.querySelectorAll("section")].map((section) =>
      section.getAttribute("aria-label"),
    );
    // Payments nests in Runbooks, so it is a row there and never its own section.
    expect(sections).toEqual(["Runbooks", "Not in a collection"]);
    const runbooks = container.querySelector("section[aria-label=Runbooks]")!;
    const titles = [...runbooks.querySelectorAll("[data-slot=list-row] [data-row-action]")].map(
      (row) => row.textContent,
    );
    expect(titles).toEqual(["Payments", "Rolling back a bad deploy"]);
    const rowsInRunbooks = [...runbooks.querySelectorAll("[data-slot=list-row]")];
    // Every row has a tile for its kind of object (a collection, an entry);
    // the decision says its type in words and ends with its date.
    const tile = (row: Element) => row.querySelector("[data-slot=logo-tile]")?.innerHTML;
    expect(rowsInRunbooks[0]!.querySelector("[data-slot=logo-tile]")).not.toBeNull();
    expect(rowsInRunbooks[1]!.querySelector("[data-slot=logo-tile]")).not.toBeNull();
    expect(tile(rowsInRunbooks[1]!)).not.toBe(tile(rowsInRunbooks[0]!));
    expect(rowsInRunbooks[1]!.textContent).toContain("Decision");
    expect(rowsInRunbooks[1]!.querySelector("[data-slot=relative-time]")).not.toBeNull();
    expect(rowsInRunbooks[0]!.querySelector("[data-slot=relative-time]")?.textContent).toStartWith(
      "Edited ",
    );
    expect(
      rowsInRunbooks[1]!.querySelector("[data-slot=relative-time]")?.textContent,
    ).not.toStartWith("Edited ");
    expect(
      listKnowledgeEntries.mock.calls.some(
        ([, request]) => request.kind === "group" && request.rootOnly === true,
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    tree = false;
  }
});
