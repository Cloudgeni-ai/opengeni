import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type {
  KnowledgeEntryListRequest,
  KnowledgeEntryListResponse,
  KnowledgeEntrySummary,
} from "@opengeni/sdk";

const list = mock(
  async (
    _workspace: string,
    _request: KnowledgeEntryListRequest,
  ): Promise<KnowledgeEntryListResponse> => ({ entries: [], nextCursor: null }),
);
const context = { client: { listKnowledgeEntries: list } };
mock.module("@/context", () => ({ useAppContext: () => context }));
const { KnowledgeTree } = await import("./knowledge-tree");
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
function entry(id: string, title: string, group = false): KnowledgeEntrySummary {
  return {
    id,
    scope: "workspace",
    updatedAt: new Date().toISOString(),
    revision: {
      title,
      kind: group ? "group" : "note",
      preview: `${title} description`,
      groupIds: [],
    },
    excerpts: [],
  } as unknown as KnowledgeEntrySummary;
}
function deferred() {
  let resolve!: (page: KnowledgeEntryListResponse) => void;
  const promise = new Promise<KnowledgeEntryListResponse>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("nested tree loads folders on demand, pages members, preserves shared entries and supports keyboard navigation", async () => {
  list.mockReset();
  const acme = entry("acme", "Acme", true),
    contracts = entry("contracts", "Contracts", true),
    billing = entry("billing", "Billing", true),
    renewal = entry("renewal", "Renewal");
  list.mockImplementation(async (_workspace, request) => ({
    entries:
      request.groupId === "acme"
        ? [contracts]
        : request.groupId === "contracts"
          ? request.cursor
            ? [entry("later", "Later renewal")]
            : [renewal]
          : [renewal],
    nextCursor: request.groupId === "contracts" && !request.cursor ? "next" : null,
  }));
  const opened = mock((_entry: KnowledgeEntrySummary) => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const row = (title: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${title}"]`)!;
  const node = (path: string) =>
    [...container.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]')].find(
      (el) => el.dataset.path === path,
    )!;
  const key = async (element: HTMLElement, pressed: string) =>
    act(async () => {
      element.focus();
      element.dispatchEvent(new KeyboardEvent("keydown", { key: pressed, bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(
        <KnowledgeTree
          workspaceId="workspace"
          entries={[acme, billing]}
          refresh={0}
          canEdit={false}
          onOpen={opened}
          onCreate={() => {}}
        />,
      ),
    );
    expect(list).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Acme description");
    await key(node("acme"), "ArrowRight");
    expect(list).toHaveBeenLastCalledWith("workspace", {
      groupId: "acme",
      view: "published",
      limit: 50,
    });
    await key(node("acme"), "ArrowRight");
    expect(document.activeElement).toBe(node("acme/contracts"));
    await key(node("acme/contracts"), "Enter");
    expect(node("acme/contracts").getAttribute("aria-expanded")).toBe("true");
    await key(node("acme/contracts/renewal"), "Enter");
    expect(opened).toHaveBeenLastCalledWith(renewal);
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Load more in Contracts")!
        .click(),
    );
    expect(node("acme/contracts/later")).toBeDefined();
    await act(async () => row("Billing").click());
    expect(container.querySelectorAll('button[aria-label="Renewal"]').length).toBe(2);
    await key(node("acme/contracts/renewal"), "ArrowLeft");
    expect(document.activeElement).toBe(node("acme/contracts"));
    await key(node("acme/contracts"), "ArrowLeft");
    expect(container.querySelectorAll('button[aria-label="Renewal"]').length).toBe(1);
    expect(opened).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a stale folder page cannot repopulate the tree after the scope changes", async () => {
  list.mockReset();
  const old = deferred();
  const folder = entry("acme", "Acme", true);
  list.mockImplementation(async (_workspace, request) =>
    request.cursor
      ? old.promise
      : {
          entries: [entry(request.scope ?? "all", request.scope ?? "All")],
          nextCursor: request.scope ? null : "old-page",
        },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (scope?: "workspace") => (
    <KnowledgeTree
      workspaceId="workspace"
      scope={scope}
      entries={[folder]}
      refresh={0}
      canEdit={false}
      onOpen={() => {}}
      onCreate={() => {}}
    />
  );
  try {
    await act(async () => root.render(render()));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Acme"]')!.click(),
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Load more in Acme")!
        .click(),
    );
    await act(async () => root.render(render("workspace")));
    await act(async () =>
      old.resolve({ entries: [entry("secret", "Stale private entry")], nextCursor: null }),
    );
    expect(container.textContent).toContain("workspace");
    expect(container.textContent).not.toContain("Stale private entry");
    expect(container.textContent).not.toContain("All");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
