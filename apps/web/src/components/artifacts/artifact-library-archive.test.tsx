import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Radix picks its layout effect when it loads, so the DOM exists first.
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
import "@/navigation-host";
import { beforeAll, expect, mock, test } from "bun:test";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import type { ReactNode } from "react";

mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => ({
    client: {},
    accessKeyVersion: 0,
    workspaces: [{ id: "workspace", accountId: "account", kind: "shared", name: "Design" }],
    managedSelfContext: null,
    accessContext: null,
  }),
}));

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let router: typeof import("@tanstack/react-router");
let ArtifactLibrary: typeof import("@opengeni/react/app/components/artifacts/artifact-library").ArtifactLibrary;
let defaultArtifactFilters: typeof import("@opengeni/react/app/lib/artifact-catalog").defaultArtifactFilters;
beforeAll(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  router = await import("@tanstack/react-router");
  ({ ArtifactLibrary } = await import("@opengeni/react/app/components/artifacts/artifact-library"));
  ({ defaultArtifactFilters } = await import("@opengeni/react/app/lib/artifact-catalog"));
});

async function renderInRouter(root: ReturnType<typeof createRoot>, node: () => ReactNode) {
  const instance = router.createRouter({
    routeTree: router.createRootRoute({ component: () => <>{node()}</> }),
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    await instance.load();
    root.render(<router.RouterProvider router={instance} />);
  });
}

const site: ArtifactCatalogItem = {
  id: "s".repeat(32),
  kind: "site",
  title: "Status board",
  status: "active",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
  versionId: "v1",
};
test("Delete… is offered for active documents, spreadsheets and presentations and asks first", async () => {
  localStorage.setItem("opengeni:artifact-library:view:v1", "list");
  const deck: ArtifactCatalogItem = {
    id: "c".repeat(32),
    kind: "presentation",
    title: "Disposable deck",
    status: "active",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    visibility: "workspace",
    ownedByViewer: true,
  };
  const archivedDeck: ArtifactCatalogItem = {
    ...deck,
    id: "d".repeat(32),
    title: "Old deck",
    status: "archived",
  };
  const archived: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const openMenu = async (title: string) => {
    const trigger = container.querySelector<HTMLButtonElement>(
      `[aria-label="More actions for ${title}"]`,
    )!;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  };
  const closeMenu = async () =>
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
  try {
    await renderInRouter(root, () => (
      <ArtifactLibrary
        workspaceId="workspace"
        items={[deck, archivedDeck, site]}
        filters={defaultArtifactFilters}
        onFiltersChange={() => {}}
        loading={false}
        onRetry={() => {}}
        onArchive={async (item) => {
          archived.push(item.id);
        }}
      />
    ));
    const label = (entries: HTMLElement[]) => entries.map((entry) => entry.textContent?.trim());
    expect(label(await openMenu("Old deck"))).not.toContain("Delete…");
    await closeMenu();
    expect(label(await openMenu("Status board"))).not.toContain("Delete…");
    await closeMenu();
    const entries = await openMenu("Disposable deck");
    const remove = entries.find((entry) => entry.textContent?.trim() === "Delete…")!;
    expect(remove).toBeDefined();
    await act(async () => remove.click());
    // Nothing happens until the person confirms.
    expect(archived).toEqual([]);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Delete Disposable deck?");
    expect(dialog.textContent).toContain("can't be opened again");
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Delete presentation",
    )!;
    await act(async () => confirm.click());
    expect(archived).toEqual([deck.id]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    localStorage.removeItem("opengeni:artifact-library:view:v1");
    container.remove();
  }
});
