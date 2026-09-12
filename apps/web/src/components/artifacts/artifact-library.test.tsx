import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactCatalogItem, RetainedArtifactReference } from "@opengeni/sdk";
import { createWorkspaceRetainedArtifactLoader } from "@/lib/retained-artifact-loader";
import {
  ARTIFACT_VIEW_KEY,
  defaultArtifactFilters,
  filterArtifactCatalog,
} from "@/lib/artifact-catalog";
let ArtifactLibrary: typeof import("./artifact-library").ArtifactLibrary;
let ArtifactThumbnail: typeof import("./artifact-library").ArtifactThumbnail;

let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register();
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ArtifactLibrary, ArtifactThumbnail } = await import("./artifact-library"));
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

test("shared library filters, persists list view, and never executes Sites", async () => {
  const previousView = localStorage.getItem(ARTIFACT_VIEW_KEY);
  localStorage.removeItem(ARTIFACT_VIEW_KEY);
  const selected: string[] = [];
  function Fixture() {
    const [filters, setFilters] = useState(defaultArtifactFilters);
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
    await act(async () => root.render(<Fixture />));
    expect(container.querySelectorAll("ul[aria-label=Artifacts] > li")).toHaveLength(2);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("Preview not available");
    await act(async () =>
      (container.querySelector('[aria-label="List view"]') as HTMLButtonElement).click(),
    );
    expect(container.querySelector('[aria-label="List view"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(localStorage.getItem("opengeni:artifact-library:view:v1")).toBe("list");
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Documents")!
        .click(),
    );
    expect(container.querySelectorAll("ul[aria-label=Artifacts] > li")).toHaveLength(1);
    await act(async () =>
      (container.querySelector('[aria-label="Open Project brief"]') as HTMLButtonElement).click(),
    );
    expect(selected).toEqual(["document:same"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (previousView === null) localStorage.removeItem(ARTIFACT_VIEW_KEY);
    else localStorage.setItem(ARTIFACT_VIEW_KEY, previousView);
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
    await act(async () => root.render(<ArtifactLibrary {...props} loading />));
    expect(container.querySelector('[aria-label="Loading artifacts"]')).not.toBeNull();
    await act(async () => root.render(<ArtifactLibrary {...props} loading={false} />));
    expect(container.textContent).toContain("No artifacts yet");
    await act(async () =>
      root.render(<ArtifactLibrary {...props} loading={false} error={new Error("Denied")} />),
    );
    expect(container.textContent).toContain("Couldn't load artifacts");
    expect(container.textContent).not.toContain("No artifacts yet");
    const retry = Array.from(container.querySelectorAll("button")).find((button) =>
      /retry|try again/i.test(button.textContent ?? ""),
    );
    await act(async () => retry!.click());
    expect(retries).toBe(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
