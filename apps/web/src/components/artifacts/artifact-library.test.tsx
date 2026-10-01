import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactCatalogItem, RetainedArtifactReference } from "@opengeni/sdk";
import { createWorkspaceRetainedArtifactLoader } from "@/lib/retained-artifact-loader";
import { defaultArtifactFilters, filterArtifactCatalog } from "@/lib/artifact-catalog";
let ArtifactLibrary: typeof import("./artifact-library").ArtifactLibrary;
let ArtifactThumbnail: typeof import("./artifact-library").ArtifactThumbnail;
let siteStillDocument: typeof import("./artifact-library").siteStillDocument;

let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register();
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ArtifactLibrary, ArtifactThumbnail, siteStillDocument } = await import("./artifact-library"));
});

test("offscreen thumbnails never mount the retained loader; visible thumbnails load once", async () => {
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  let notify: IntersectionObserverCallback | undefined;
  let rootMargin: string | undefined;
  let disconnected = false;
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        notify = callback;
        rootMargin = options?.rootMargin;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  });
  const loaded: string[] = [];
  const reference: RetainedArtifactReference = {
    available: true,
    artifactId: "image",
    kind: "file",
    contentType: "image/png",
    originalBytes: 1,
    sha256: "a".repeat(64),
    retainedAt: "2026-09-01T00:00:00Z",
    retention: { policy: "workspace_file", expiresAt: null },
    retrieval: {
      method: "GET",
      path: "/retained/image",
      acceptRanges: "bytes",
      maxRangeBytes: 1048576,
    },
  };
  const load = createWorkspaceRetainedArtifactLoader(
    {
      downloadRetainedArtifact: async (_workspaceId, artifactReference) => {
        loaded.push(artifactReference.artifactId);
        return { artifact: artifactReference, bytes: new Uint8Array([0]) };
      },
      createRetainedArtifactDownloadUrl: async () => {
        throw new Error("Unexpected signed URL");
      },
    },
    "workspace",
  );
  function RetainedLoaderProbe() {
    useEffect(() => {
      const abort = new AbortController();
      void load(reference, abort.signal);
      return () => abort.abort();
    }, []);
    return <span>Loaded thumbnail</span>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ArtifactThumbnail>
          <RetainedLoaderProbe />
        </ArtifactThumbnail>,
      ),
    );
    expect(rootMargin).toBe("200px 0px");
    expect(loaded).toEqual([]);
    await act(async () =>
      notify?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(loaded).toEqual([]);
    await act(async () =>
      notify?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
    );
    expect(loaded).toEqual(["image"]);
    expect(disconnected).toBe(true);
    await act(async () =>
      notify?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
    );
    expect(loaded).toEqual(["image"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (previousObserver)
      Object.defineProperty(globalThis, "IntersectionObserver", previousObserver);
    else Reflect.deleteProperty(globalThis, "IntersectionObserver");
  }
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const items: ArtifactCatalogItem[] = [
  {
    id: "same",
    kind: "site",
    title: "Status board",
    status: "active",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    versionId: "v1",
  },
  {
    id: "same",
    kind: "document",
    title: "Project brief",
    status: "active",
    createdAt: "2026-09-02T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
  },
];

async function renderInRouter(root: ReturnType<typeof createRoot>, node: () => ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <>{node()}</> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
}

test("a Site still blocks scripts and the network before any of the Site's markup", () => {
  const still = siteStillDocument(
    "<html><head><script>alert(1)</script></head><body>Hi</body></html>",
  );
  expect(still.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
  expect(still).toContain("default-src 'none'");
  expect(still).not.toContain("script-src");
  expect(still.indexOf("Content-Security-Policy")).toBeLessThan(still.indexOf("<script>"));
});

test("the gallery is the default; List shows flush rows and is remembered", async () => {
  localStorage.removeItem("opengeni:artifact-library:view:v1");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    renderInRouter(root, () => (
      <ArtifactLibrary
        workspaceId="workspace"
        items={items}
        filters={defaultArtifactFilters}
        onFiltersChange={() => {}}
        loading={false}
        onRetry={() => {}}
        onSelect={() => {}}
      />
    ));
  try {
    await render();
    const cards = container.querySelectorAll("ul[aria-label=Artifacts] > li");
    expect(cards).toHaveLength(2);
    expect(container.querySelector('[data-slot="list-row"]')).toBeNull();
    expect(cards[0]!.textContent).toContain("Site · updated");
    const list = container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="List"]');
    await act(async () => list!.click());
    expect(localStorage.getItem("opengeni:artifact-library:view:v1")).toBe("list");
    expect(container.querySelector("[data-card-action]")).toBeNull();
    await act(async () => root.unmount());
    const again = createRoot(container);
    await renderInRouter(again, () => (
      <ArtifactLibrary
        workspaceId="workspace"
        items={items}
        filters={defaultArtifactFilters}
        onFiltersChange={() => {}}
        loading={false}
        onRetry={() => {}}
      />
    ));
    expect(container.querySelector("[data-card-action]")).toBeNull();
    expect(container.querySelectorAll("ul[aria-label=Artifacts] > li")).toHaveLength(2);
    await act(async () => again.unmount());
  } finally {
    localStorage.removeItem("opengeni:artifact-library:view:v1");
    container.remove();
  }
});

test("shared library lists the type as a word and never executes Sites", async () => {
  const selected: string[] = [];
  let setKind: (kind: "all" | "document") => void = () => {};
  function Fixture() {
    const [filters, setFilters] = useState(defaultArtifactFilters);
    setKind = (kind) => setFilters((current) => ({ ...current, kind }));
    return (
      <ArtifactLibrary
        workspaceId="workspace"
        items={filterArtifactCatalog(items, filters)}
        filters={filters}
        onFiltersChange={setFilters}
        loading={false}
        onRetry={() => {}}
        onSelect={(item) => selected.push(`${item.kind}:${item.id}`)}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await renderInRouter(root, () => <Fixture />);
    const rows = () => container.querySelectorAll("ul[aria-label=Artifacts] > li");
    expect(rows()).toHaveLength(2);
    expect(container.querySelector("iframe")).toBeNull();
    expect(rows()[0]!.textContent).toContain("Document");
    expect(rows()[1]!.textContent).toContain("Site");
    await act(async () => setKind("document"));
    expect(rows()).toHaveLength(1);
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Project brief")!
        .click(),
    );
    expect(selected).toEqual(["document:same"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("loading, empty, and error states stay explicit with a retry", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let retries = 0;
  const props = {
    workspaceId: "workspace",
    items: [],
    filters: defaultArtifactFilters,
    onFiltersChange: () => {},
    onRetry: () => {
      retries++;
    },
  };
  try {
    await renderInRouter(root, () => <ArtifactLibrary {...props} loading />);
    expect(container.querySelector('[aria-label="Loading artifacts"]')).not.toBeNull();
    await renderInRouter(root, () => <ArtifactLibrary {...props} loading={false} />);
    expect(container.textContent).toContain("No artifacts yet");
    await renderInRouter(root, () => (
      <ArtifactLibrary {...props} loading={false} error={new Error("Denied")} />
    ));
    expect(container.textContent).toContain("Couldn't load artifacts");
    expect(container.textContent).not.toContain("No artifacts yet");
    const retry = Array.from(container.querySelectorAll("button")).find((button) =>
      /retry|try again/i.test(button.textContent ?? ""),
    );
    await act(async () => retry!.click());
    expect(retries).toBe(1);
    await renderInRouter(root, () => (
      <ArtifactLibrary
        {...props}
        loading={false}
        error={Object.assign(
          new Error("OpenGeni API 503: upstream unavailable Reference: req_503."),
          { status: 503 },
        )}
      />
    ));
    expect(container.textContent).toContain("Couldn't load artifacts");
    expect(container.textContent).toContain("Try again in a moment.");
    expect(container.textContent).not.toContain("OpenGeni API");
    expect(container.textContent).not.toContain("req_503");
    await renderInRouter(root, () => (
      <ArtifactLibrary
        {...props}
        loading={false}
        error={Object.assign(
          new Error("OpenGeni API 403: missing permission: artifacts:read Reference: req_403."),
          { status: 403 },
        )}
      />
    ));
    expect(container.textContent).toContain("You can't see artifacts here.");
    expect(container.textContent).not.toContain("Couldn't load artifacts");
    expect(container.textContent).not.toContain("missing permission");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        /retry|try again/i.test(button.textContent ?? ""),
      ),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("hidden Sites and documents are explained instead of reported as missing", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = {
    workspaceId: "workspace",
    onFiltersChange: () => {},
    onRetry: () => {},
    loading: false,
    artifactKindsHidden: true,
  };
  const access = "You need access to artifacts in this workspace. Ask a workspace admin.";
  try {
    // A Sites tab without artifacts:read is a permission gap, never "No sites yet".
    await renderInRouter(root, () => (
      <ArtifactLibrary
        {...props}
        items={[]}
        filters={{ ...defaultArtifactFilters, kind: "site" }}
      />
    ));
    expect(container.textContent).toContain("You can't see sites here.");
    expect(container.textContent).toContain(access);
    expect(container.textContent).not.toContain("No sites yet");
    await renderInRouter(root, () => (
      <ArtifactLibrary
        {...props}
        items={[]}
        filters={{ ...defaultArtifactFilters, kind: "document" }}
      />
    ));
    expect(container.textContent).toContain("You can't see documents here.");
    // Files the viewer can read still list, with the hidden kinds named above them.
    const file: ArtifactCatalogItem = {
      id: "file",
      kind: "file",
      title: "notes.txt",
      status: "active",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-02T00:00:00Z",
    };
    await renderInRouter(root, () => (
      <ArtifactLibrary {...props} items={[file]} filters={defaultArtifactFilters} />
    ));
    expect(container.textContent).toContain("Sites and documents are hidden");
    expect(container.textContent).toContain(access);
    expect(container.textContent).toContain("notes.txt");
    await renderInRouter(root, () => (
      <ArtifactLibrary
        {...props}
        items={[file]}
        filters={{ ...defaultArtifactFilters, kind: "file" }}
      />
    ));
    expect(container.textContent).not.toContain(access);
    // A viewer who can read artifacts sees no notice.
    await renderInRouter(root, () => (
      <ArtifactLibrary
        {...props}
        artifactKindsHidden={false}
        items={[]}
        filters={{ ...defaultArtifactFilters, kind: "site" }}
      />
    ));
    expect(container.textContent).toContain("No sites yet.");
    expect(container.textContent).not.toContain(access);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
