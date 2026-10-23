import "@/navigation-host";
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactCatalogItem, RetainedArtifactReference } from "@opengeni/sdk";
import { configurePageAppHost } from "@opengeni/react/app/lib/app-host";
import {
  defaultArtifactFilters,
  filterArtifactCatalog,
  type ArtifactCatalogFilters,
} from "@opengeni/react/app/lib/artifact-catalog";

// Documents show the host's editable surface in the viewer, as in the session panel.
configurePageAppHost({
  surfaces: {
    editableArtifact: ({ artifactId }: { artifactId: string }) => (
      <div data-native-preview={artifactId}>
        <button type="button">Inside the document</button>
      </div>
    ),
  },
});

// Every test gets a fresh client, so the page's retained-image cache starts empty.
const app: { client: ReturnType<typeof fakeClient>["client"] } = { client: fakeClient().client };
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => ({
    client: app.client,
    accessKeyVersion: 0,
    workspaces: [{ id: "workspace", accountId: "account", kind: "shared", name: "Design" }],
    managedSelfContext: null,
    accessContext: null,
  }),
}));

let ArtifactLibrary: typeof import("@opengeni/react/app/components/artifacts/artifact-library").ArtifactLibrary;

function reference(artifactId: string): RetainedArtifactReference {
  return {
    available: true,
    artifactId,
    kind: "file",
    contentType: "image/png",
    originalBytes: 1,
    sha256: artifactId.padEnd(64, "0"),
    retainedAt: "2026-09-01T00:00:00Z",
    retention: { policy: "workspace_file", expiresAt: null },
    retrieval: {
      method: "GET",
      path: `/retained/${artifactId}`,
      acceptRanges: "bytes",
      maxRangeBytes: 1048576,
    },
  };
}

function fakeClient() {
  const metadata: string[] = [];
  const bytes: string[] = [];
  const client = {
    getRetainedArtifact: async (_workspaceId: string, artifactId: string) => {
      metadata.push(artifactId);
      return reference(artifactId);
    },
    downloadRetainedArtifact: async (_workspaceId: string, artifact: RetainedArtifactReference) => {
      bytes.push(artifact.artifactId);
      return { artifact, bytes: new Uint8Array([137, 80, 78, 71]) };
    },
    createRetainedArtifactDownloadUrl: async () => {
      throw new Error("Unexpected signed URL");
    },
  };
  return { client, metadata, bytes };
}

const entry = (
  id: string,
  kind: ArtifactCatalogItem["kind"],
  title: string,
  updatedAt: string,
): ArtifactCatalogItem => ({
  id,
  kind,
  title,
  status: "active",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt,
});

// Newest first, as the panel lists them.
const catalog: ArtifactCatalogItem[] = [
  entry("shot-1", "image", "shot-1.png", "2026-09-06T00:00:00Z"),
  entry("shot-2", "image", "shot-2.png", "2026-09-05T00:00:00Z"),
  entry("plan", "document", "Plan", "2026-09-04T00:00:00Z"),
  entry("shot-3", "image", "shot-3.png", "2026-09-03T00:00:00Z"),
  entry("shot-4", "image", "shot-4.png", "2026-09-02T00:00:00Z"),
];

let ownsDom = false;
let previousObserver: PropertyDescriptor | undefined;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Thumbnails stay offscreen, so every retained request comes from the viewer.
  previousObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
  ({ ArtifactLibrary } = await import("@opengeni/react/app/components/artifacts/artifact-library"));
});

afterAll(async () => {
  if (previousObserver) Object.defineProperty(globalThis, "IntersectionObserver", previousObserver);
  else Reflect.deleteProperty(globalThis, "IntersectionObserver");
  if (ownsDom) await GlobalRegistrator.unregister();
});

const mounted: { root: ReturnType<typeof createRoot>; container: HTMLElement }[] = [];
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

async function render(node: () => ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <>{node()}</> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  return container;
}

async function settle() {
  for (let tick = 0; tick < 5; tick++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const viewer = () => document.querySelector<HTMLElement>("[data-artifact-viewer]");
const position = () => viewer()?.querySelector("[data-artifact-viewer-position]")?.textContent;
const viewerTitle = () => viewer()?.querySelector("h2")?.textContent;
const control = (label: string) =>
  viewer()!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

async function openFromList(container: HTMLElement, title: string) {
  const action = [...container.querySelectorAll<HTMLElement>("[data-card-action]")].find(
    (candidate) => candidate.textContent === title,
  );
  expect(action).toBeDefined();
  await act(async () => action!.click());
  await settle();
}

async function press(key: string, target: Element = viewer()!) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

function Library({
  initialFilters = defaultArtifactFilters,
  onSelect,
}: {
  initialFilters?: ArtifactCatalogFilters | undefined;
  onSelect?: ((item: ArtifactCatalogItem) => void) | undefined;
}) {
  const [filters, setFilters] = useState(initialFilters);
  return (
    <ArtifactLibrary
      workspaceId="workspace"
      compact
      viewer
      items={filterArtifactCatalog(catalog, filters)}
      filters={filters}
      onFiltersChange={setFilters}
      loading={false}
      onRetry={() => {}}
      onSelect={onSelect ?? (() => {})}
    />
  );
}

test("an image opens large and the buttons step through the list in its order", async () => {
  localStorage.removeItem("opengeni:artifact-library:view:v1");
  app.client = fakeClient().client;
  const container = await render(() => <Library />);
  expect(viewer()).toBeNull();
  await openFromList(container, "shot-2.png");
  expect(viewer()).not.toBeNull();
  expect(viewerTitle()).toBe("shot-2.png");
  expect(position()).toBe("2 of 5");
  expect(viewer()!.querySelector("img")?.getAttribute("alt")).toBe("shot-2.png");

  // A document in the list is part of the sequence, shown with its own preview.
  await act(async () => control("Next").click());
  expect(position()).toBe("3 of 5");
  expect(viewerTitle()).toBe("Plan");
  expect(
    viewer()!.querySelector("[data-native-preview]")?.getAttribute("data-native-preview"),
  ).toBe("plan");
  await act(async () => control("Next").click());
  await act(async () => control("Next").click());
  expect(position()).toBe("5 of 5");
  expect(viewerTitle()).toBe("shot-4.png");
  // The ends are ends: no wrapping around.
  expect(control("Next").disabled).toBe(true);
  for (let step = 0; step < 4; step++) await act(async () => control("Previous").click());
  expect(position()).toBe("1 of 5");
  expect(control("Previous").disabled).toBe(true);
  expect(control("Next").disabled).toBe(false);
});

test("Left and Right arrow keys step, never from inside a document, and Escape closes", async () => {
  app.client = fakeClient().client;
  const container = await render(() => <Library />);
  await openFromList(container, "shot-1.png");
  expect(position()).toBe("1 of 5");
  await press("ArrowRight");
  expect(position()).toBe("2 of 5");
  await press("ArrowLeft");
  expect(position()).toBe("1 of 5");
  // Modified arrows belong to the browser and the system.
  await press("ArrowRight", viewer()!);
  await act(async () => {
    viewer()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, bubbles: true }),
    );
  });
  expect(position()).toBe("2 of 5");
  await press("ArrowRight");
  expect(viewerTitle()).toBe("Plan");
  // Arrow keys inside the document being read move within it.
  await press("ArrowRight", viewer()!.querySelector("[data-native-preview] button")!);
  expect(position()).toBe("3 of 5");
  await press("ArrowRight");
  expect(position()).toBe("4 of 5");

  await press("Escape");
  expect(viewer()).toBeNull();
  // Opening again starts from the artifact clicked.
  await openFromList(container, "shot-4.png");
  expect(position()).toBe("5 of 5");
  await act(async () => control("Close").click());
  expect(viewer()).toBeNull();
});

test("the sequence is the filtered list: search narrows what the viewer steps through", async () => {
  app.client = fakeClient().client;
  const container = await render(() => (
    <Library initialFilters={{ ...defaultArtifactFilters, q: "shot", sort: "title" }} />
  ));
  await openFromList(container, "shot-3.png");
  expect(position()).toBe("3 of 4");
  await press("ArrowRight");
  expect(viewerTitle()).toBe("shot-4.png");
  expect(position()).toBe("4 of 4");
  await press("ArrowRight");
  expect(position()).toBe("4 of 4");
  for (let step = 0; step < 3; step++) await press("ArrowLeft");
  expect(viewerTitle()).toBe("shot-1.png");
  // The document was filtered out, so it never appears.
  expect(viewer()!.querySelector("[data-native-preview]")).toBeNull();
});

test("neighbouring images load ahead; documents still open where they are edited", async () => {
  const fake = fakeClient();
  app.client = fake.client;
  const selected: string[] = [];
  const container = await render(() => (
    <Library onSelect={(item) => selected.push(`${item.kind}:${item.id}`)} />
  ));
  await openFromList(container, "shot-1.png");
  // The image on screen and the next one; nothing further down the list.
  expect([...new Set(fake.metadata)].sort()).toEqual(["shot-1", "shot-2"]);
  expect([...new Set(fake.bytes)].sort()).toEqual(["shot-1", "shot-2"]);
  await press("ArrowRight");
  // Stepping shows the preloaded image without asking for it again.
  expect(fake.metadata.filter((id) => id === "shot-2")).toHaveLength(1);
  expect(fake.bytes.filter((id) => id === "shot-2")).toHaveLength(1);
  await act(async () => control("Close").click());

  // A document opens in the session's panel, as before, not in the viewer.
  await openFromList(container, "Plan");
  expect(viewer()).toBeNull();
  expect(selected).toEqual(["document:plan"]);
});

test("the workspace library keeps opening images on their page, where it browses", async () => {
  app.client = fakeClient().client;
  const selected: string[] = [];
  const container = await render(() => (
    <ArtifactLibrary
      workspaceId="workspace"
      items={catalog}
      filters={defaultArtifactFilters}
      onFiltersChange={() => {}}
      loading={false}
      onRetry={() => {}}
      onSelect={(item) => selected.push(`${item.kind}:${item.id}`)}
    />
  ));
  await openFromList(container, "shot-2.png");
  expect(viewer()).toBeNull();
  expect(selected).toEqual(["image:shot-2"]);
});
