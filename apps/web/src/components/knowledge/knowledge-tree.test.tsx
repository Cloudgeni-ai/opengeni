import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";
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
const context = {
  client: { listKnowledgeEntries: list },
  accessContext: {},
  workspaceStateOwnerId: "workspace",
};
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

async function mountedTree(strict = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const folders = [entry("acme", "Acme", true), entry("other", "Other", true)];
  const render = async (options: { refresh?: number; workspaceId?: string } = {}) =>
    act(async () => root.render(strict ? <StrictMode>{tree(options)}</StrictMode> : tree(options)));
  const tree = (options: { refresh?: number; workspaceId?: string }) => (
    <KnowledgeTree
      workspaceId={options.workspaceId ?? "workspace"}
      entries={folders}
      refresh={options.refresh ?? 0}
      canEdit={false}
      onOpen={() => {}}
      onCreate={() => {}}
    />
  );
  const click = async (title: string) =>
    act(async () =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${title}"]`)!.click(),
    );
  await render();
  return {
    container,
    render,
    click,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("reopening a loaded collection hides prior rows until a fresh first page arrives", async () => {
  list.mockReset();
  list.mockResolvedValue({ entries: [entry("member", "Cached member")], nextCursor: "next" });
  const tree = await mountedTree();
  try {
    await tree.click("Acme");
    expect(tree.container.textContent).toContain("Cached member");
    await tree.click("Acme");
    expect(tree.container.textContent).not.toContain("Cached member");
    const held = deferred();
    list.mockReturnValue(held.promise);
    await tree.click("Acme");
    expect(tree.container.textContent).not.toContain("Cached member");
    expect(tree.container.textContent).toContain("Loading collection");
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () =>
      held.resolve({ entries: [entry("fresh", "Fresh member")], nextCursor: "next" }),
    );
    expect(tree.container.textContent).toContain("Fresh member");
    expect(tree.container.textContent).toContain("Load more in Acme");
  } finally {
    await tree.close();
  }
});

test("collapse and reopen during a held request does not issue duplicate work", async () => {
  list.mockReset();
  const held = deferred();
  list.mockReturnValue(held.promise);
  const tree = await mountedTree();
  try {
    await tree.click("Acme");
    await tree.click("Acme");
    await tree.click("Acme");
    expect(list).toHaveBeenCalledTimes(1);
    expect(tree.container.textContent).toContain("Loading collection");
    await act(async () =>
      held.resolve({ entries: [entry("member", "Current member")], nextCursor: null }),
    );
    expect(tree.container.textContent).toContain("Current member");
    expect(tree.container.textContent).not.toContain("Loading collection");
  } finally {
    await tree.close();
  }
});

test("remote revocation cannot redisplay previously loaded rows on immediate reopen", async () => {
  list.mockReset();
  list.mockResolvedValue({ entries: [entry("old", "Revoked member")], nextCursor: null });
  const tree = await mountedTree();
  try {
    await tree.click("Acme");
    expect(tree.container.textContent).toContain("Revoked member");
    await tree.click("Acme");
    list.mockRejectedValue(new Error("403 Forbidden after remote revocation"));
    await tree.click("Acme");
    expect(list).toHaveBeenCalledTimes(2);
    expect(tree.container.textContent).not.toContain("Revoked member");
    expect(tree.container.textContent).toContain("403 Forbidden after remote revocation");
  } finally {
    await tree.close();
  }
});

test("edits, workspace, access-context and client changes invalidate collection rows", async () => {
  const originalClient = context.client;
  const originalAccess = context.accessContext;
  list.mockReset();
  list.mockResolvedValue({ entries: [entry("old", "Old member")], nextCursor: null });
  const tree = await mountedTree();
  try {
    await tree.click("Acme");
    const changes = [
      () => tree.render({ refresh: 1 }),
      () => tree.render({ workspaceId: "another-workspace", refresh: 1 }),
      () => {
        context.accessContext = {};
        return tree.render({ workspaceId: "another-workspace", refresh: 1 });
      },
      () => {
        context.client = { listKnowledgeEntries: list };
        return tree.render({ workspaceId: "another-workspace", refresh: 1 });
      },
    ];
    for (const change of changes) {
      const held = deferred();
      list.mockReturnValue(held.promise);
      await change();
      expect(tree.container.textContent).not.toContain("Old member");
      expect(tree.container.textContent).toContain("Loading collection");
      await act(async () =>
        held.resolve({ entries: [entry("old", "Old member")], nextCursor: null }),
      );
      expect(tree.container.textContent).toContain("Old member");
    }
    expect(list).toHaveBeenCalledTimes(5);
  } finally {
    context.client = originalClient;
    context.accessContext = originalAccess;
    await tree.close();
  }
});

test("a failed request can be retried and reopened pagination starts from a fresh first page", async () => {
  list.mockReset();
  list.mockRejectedValueOnce(new Error("Try again"));
  const tree = await mountedTree();
  const clickText = async (text: string) =>
    act(async () =>
      [...tree.container.querySelectorAll("button")]
        .find((button) => button.textContent === text)!
        .click(),
    );
  try {
    await tree.click("Acme");
    expect(tree.container.textContent).toContain("Try again");
    list.mockResolvedValue({ entries: [entry("first", "First member")], nextCursor: "next" });
    await clickText("Retry");
    list.mockResolvedValue({ entries: [entry("later", "Later member")], nextCursor: null });
    await clickText("Load more in Acme");
    expect(tree.container.textContent).toContain("Later member");
    await tree.click("Acme");
    list.mockResolvedValue({ entries: [entry("first", "First member")], nextCursor: "next" });
    await tree.click("Acme");
    expect(tree.container.textContent).toContain("First member");
    expect(tree.container.textContent).not.toContain("Later member");
    list.mockResolvedValue({ entries: [entry("later", "Later member")], nextCursor: null });
    await clickText("Load more in Acme");
    expect(list).toHaveBeenCalledTimes(5);
    expect(tree.container.querySelectorAll('button[aria-label="First member"]')).toHaveLength(1);
    expect(tree.container.querySelectorAll('button[aria-label="Later member"]')).toHaveLength(1);
  } finally {
    await tree.close();
  }
});

test("a previous authorization request cannot populate the replacement request context", async () => {
  const originalAccess = context.accessContext;
  const old = deferred();
  const current = deferred();
  list.mockReset();
  list.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const tree = await mountedTree();
  try {
    await tree.click("Acme");
    context.accessContext = {};
    await tree.render();
    await act(async () =>
      current.resolve({
        entries: [entry("current", "Current authorized member")],
        nextCursor: null,
      }),
    );
    await act(async () =>
      old.resolve({ entries: [entry("old", "Previous principal member")], nextCursor: null }),
    );
    await tree.click("Acme");
    list.mockResolvedValue({
      entries: [entry("current", "Current authorized member")],
      nextCursor: null,
    });
    await tree.click("Acme");
    expect(tree.container.textContent).toContain("Current authorized member");
    expect(tree.container.textContent).not.toContain("Previous principal member");
    expect(list).toHaveBeenCalledTimes(3);
  } finally {
    context.accessContext = originalAccess;
    await tree.close();
  }
});

test("the same collection at two tree paths shares only an in-flight first page", async () => {
  list.mockReset();
  const held = deferred();
  list.mockImplementation(async (_workspace, request) =>
    request.groupId === "other"
      ? { entries: [entry("acme", "Acme", true)], nextCursor: null }
      : held.promise,
  );
  const tree = await mountedTree();
  try {
    await tree.click("Acme");
    await tree.click("Other");
    await act(async () =>
      tree.container
        .querySelector<HTMLButtonElement>('[data-path="other/acme"] button[aria-label="Acme"]')!
        .click(),
    );
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () =>
      held.resolve({ entries: [entry("member", "Shared member")], nextCursor: null }),
    );
    expect(tree.container.querySelectorAll('button[aria-label="Shared member"]')).toHaveLength(2);
  } finally {
    await tree.close();
  }
});

test("workspace owner reset invalidates rows without changing access, client or props", async () => {
  const originalOwner = context.workspaceStateOwnerId;
  list.mockReset();
  list.mockResolvedValue({ entries: [entry("old", "Old owner member")], nextCursor: null });
  const tree = await mountedTree();
  try {
    await tree.click("Acme");
    context.workspaceStateOwnerId = "replacement-owner";
    list.mockResolvedValue({ entries: [], nextCursor: null });
    await tree.render();
    expect(tree.container.textContent).not.toContain("Old owner member");
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    context.workspaceStateOwnerId = originalOwner;
    await tree.close();
  }
});

test("StrictMode effect replay shares the pending first-page request", async () => {
  list.mockReset();
  list.mockResolvedValue({ entries: [entry("member", "Strict member")], nextCursor: null });
  const tree = await mountedTree(true);
  try {
    await tree.click("Acme");
    expect(list).toHaveBeenCalledTimes(1);
    expect(tree.container.textContent).toContain("Strict member");
  } finally {
    await tree.close();
  }
});
