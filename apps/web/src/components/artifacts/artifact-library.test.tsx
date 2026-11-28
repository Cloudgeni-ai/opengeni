import "@/navigation-host";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
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
import { createWorkspaceRetainedArtifactLoader } from "@opengeni/react";
import {
  defaultArtifactFilters,
  filterArtifactCatalog,
} from "@opengeni/react/app/lib/artifact-catalog";
import { configureContentHosting } from "@opengeni/react/app/lib/content-hosting";
import {
  HTML_FRAME_PREVIEW_POLICY,
  SITE_PREVIEW_PAINTED_MESSAGE,
} from "@opengeni/sdk/site-preview";

// The client the cards read through; a test sets the calls it needs.
const testClient: Record<string, unknown> = {};
// Rows ask the app who the viewer is, to offer a file's owner its share action.
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => ({
    client: testClient,
    accessKeyVersion: 0,
    workspaces: [{ id: "workspace", accountId: "account", kind: "shared", name: "Design" }],
    managedSelfContext: null,
    accessContext: null,
  }),
}));
let ArtifactLibrary: typeof import("@opengeni/react/app/components/artifacts/artifact-library").ArtifactLibrary;
let ArtifactThumbnail: typeof import("@opengeni/react/app/components/artifacts/artifact-library").ArtifactThumbnail;

let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register();
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ArtifactLibrary, ArtifactThumbnail } =
    await import("@opengeni/react/app/components/artifacts/artifact-library"));
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

/** Observers of the cards in view, so a test can scroll them away. */
const cardObservers: Array<{ callback: IntersectionObserverCallback; observer: unknown }> = [];
const scrollCardsAway = () =>
  act(async () => {
    for (const { callback, observer } of cardObservers.splice(0))
      callback(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        observer as IntersectionObserver,
      );
  });

/** Cards in view at once, with a measurable box, for the length of `run`. */
async function withVisibleCards(run: () => Promise<void>) {
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  const previousWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const previousHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe() {
        cardObservers.push({ callback: this.callback, observer: this });
        this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {
        const index = cardObservers.findIndex((entry) => entry.observer === this);
        if (index >= 0) cardObservers.splice(index, 1);
      }
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 320,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 200,
  });
  try {
    await run();
  } finally {
    for (const [target, key, previous] of [
      [globalThis, "IntersectionObserver", previousObserver],
      [HTMLElement.prototype, "clientWidth", previousWidth],
      [HTMLElement.prototype, "clientHeight", previousHeight],
    ] as const) {
      if (previous) Object.defineProperty(target, key, previous);
      else Reflect.deleteProperty(target, key);
    }
    for (const key of Object.keys(testClient)) delete testClient[key];
    configureContentHosting({});
  }
}

test("an app's card runs the page in a scripts-only frame and shows it once it painted", async () => {
  await withVisibleCards(async () => {
    configureContentHosting({ htmlFrameHost: "https://og.example.site" });
    const html =
      '<div id="app"></div><script src="/__opengeni/site-tools/client.js"></script><script>app.innerHTML="<h1>Issues</h1>"</script>';
    testClient["getWorkspaceArtifactHtml"] = async () => html;
    const sites: ArtifactCatalogItem[] = [
      { ...items[0]!, id: "painted", title: "Issue tracker", versionId: "p1" },
      { ...items[0]!, id: "blank", title: "Deployments", versionId: "b1" },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await renderInRouter(root, () => (
        <ArtifactLibrary
          workspaceId="workspace"
          items={sites}
          filters={defaultArtifactFilters}
          onFiltersChange={() => {}}
          loading={false}
          onRetry={() => {}}
        />
      ));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      const frame = (title: string) =>
        container.querySelector<HTMLIFrameElement>(`iframe[title="Preview of ${title}"]`);
      const card = (title: string) =>
        Array.from(container.querySelectorAll("ul[aria-label=Artifacts] > li")).find((li) =>
          li.textContent?.includes(title),
        )!;
      for (const title of ["Issue tracker", "Deployments"]) {
        const element = frame(title)!;
        // The page's own scripts may run, in an opaque origin, through the frame host.
        expect(element.getAttribute("sandbox")).toBe("allow-scripts");
        expect(element.getAttribute("src")).toStartWith("https://og.example.site/_og/html-frame");
        expect(element.getAttribute("srcdoc")).toBeNull();
        // Until it reports, the card keeps its glyph and the frame stays hidden.
        expect(element.closest(".opacity-0")).not.toBeNull();
        expect(card(title).querySelector("svg")).not.toBeNull();
      }
      // Happy DOM loads no frame pages; give each frame a window of its own.
      for (const title of ["Issue tracker", "Deployments"])
        Object.defineProperty(frame(title)!, "contentWindow", { value: { title } });
      const report = async (title: string, painted: boolean, origin = "null") =>
        act(async () => {
          const event = new MessageEvent("message", {
            data: { type: SITE_PREVIEW_PAINTED_MESSAGE, painted },
            origin,
          });
          Object.defineProperty(event, "source", { value: frame(title)!.contentWindow });
          window.dispatchEvent(event);
        });
      // A named origin is not the card's sandboxed frame.
      await report("Issue tracker", true, "https://evil.example");
      expect(frame("Issue tracker")!.closest(".opacity-0")).not.toBeNull();
      await report("Issue tracker", true);
      expect(frame("Issue tracker")!.closest(".opacity-100")).not.toBeNull();
      // A page that drew nothing never shows as a blank tile: the glyph stays.
      await report("Deployments", false);
      expect(frame("Deployments")).toBeNull();
      expect(card("Deployments").querySelector("svg")).not.toBeNull();
      // A slow page whose load finishes after its report stays painted.
      await act(async () => {
        frame("Issue tracker")!.dispatchEvent(new Event("load"));
      });
      expect(frame("Issue tracker")!.closest(".opacity-100")).not.toBeNull();
      // A painted page that then navigates itself away says so and is dropped for the glyph.
      await report("Issue tracker", false);
      expect(frame("Issue tracker")).toBeNull();
      expect(card("Issue tracker").querySelector("svg")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

test("a Site's live frame runs only while its card is near the viewport", async () => {
  await withVisibleCards(async () => {
    configureContentHosting({ htmlFrameHost: "https://og.example.site" });
    testClient["getWorkspaceArtifactHtml"] = async () => "<h1>Dashboard</h1>";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await renderInRouter(root, () => (
        <ArtifactLibrary
          workspaceId="workspace"
          items={[{ ...items[0]!, id: "dash", title: "Dashboard", versionId: "d1" }]}
          filters={defaultArtifactFilters}
          onFiltersChange={() => {}}
          loading={false}
          onRetry={() => {}}
        />
      ));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(container.querySelector('iframe[title="Preview of Dashboard"]')).not.toBeNull();
      // Marked while it runs, so a page that hangs the tab is skipped after a reload.
      expect(sessionStorage.getItem("opengeni:site-preview:pending:dash:d1")).toBe("1");
      // A tab that leaves normally (reload, sign-out) clears its marks; only a hung one keeps them.
      await act(async () => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(sessionStorage.getItem("opengeni:site-preview:pending:dash:d1")).toBeNull();
      await scrollCardsAway();
      expect(container.querySelector('iframe[title="Preview of Dashboard"]')).toBeNull();
      expect(sessionStorage.getItem("opengeni:site-preview:pending:dash:d1")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

test("without a frame host, a Site's card runs the same reporting preview in a scripts-only srcdoc frame", async () => {
  await withVisibleCards(async () => {
    testClient["getWorkspaceArtifactHtml"] = async () =>
      '<div id="app"></div><script>app.textContent="Open issues"</script>';
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await renderInRouter(root, () => (
        <ArtifactLibrary
          workspaceId="workspace"
          items={[{ ...items[0]!, id: "issues", title: "Issue tracker", versionId: "i1" }]}
          filters={defaultArtifactFilters}
          onFiltersChange={() => {}}
          loading={false}
          onRetry={() => {}}
        />
      ));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      const frame = container.querySelector<HTMLIFrameElement>(
        'iframe[title="Preview of Issue tracker"]',
      )!;
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
      const srcdoc = frame.getAttribute("srcdoc")!;
      expect(srcdoc).toStartWith(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_FRAME_PREVIEW_POLICY}">`,
      );
      expect(srcdoc).toContain(SITE_PREVIEW_PAINTED_MESSAGE);
      // Its own load, then a report: shown. A second load is the page navigating away.
      Object.defineProperty(frame, "contentWindow", { value: { title: "issues" } });
      await act(async () => {
        frame.dispatchEvent(new Event("load"));
        const event = new MessageEvent("message", {
          data: { type: SITE_PREVIEW_PAINTED_MESSAGE, painted: true },
          origin: "null",
        });
        Object.defineProperty(event, "source", { value: frame.contentWindow });
        window.dispatchEvent(event);
      });
      expect(frame.closest(".opacity-100")).not.toBeNull();
      await act(async () => {
        frame.dispatchEvent(new Event("load"));
      });
      expect(container.querySelector('iframe[title="Preview of Issue tracker"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

test("a document's card shows a picture of its first page, and its glyph if there is none", async () => {
  await withVisibleCards(async () => {
    const requested: Array<{ id: string; options: unknown }> = [];
    testClient["getEditableArtifactPreview"] = async (
      _workspaceId: string,
      id: string,
      options?: unknown,
    ) => {
      requested.push({ id, options });
      if (id === "broken") throw new Error("unavailable");
      return '<svg xmlns="http://www.w3.org/2000/svg"><text>Project brief</text></svg>';
    };
    const documents: ArtifactCatalogItem[] = [
      { ...items[1]!, id: "brief", title: "Project brief" },
      { ...items[1]!, id: "broken", title: "Old notes" },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await renderInRouter(root, () => (
        <ArtifactLibrary
          workspaceId="workspace"
          items={documents}
          filters={defaultArtifactFilters}
          onFiltersChange={() => {}}
          loading={false}
          onRetry={() => {}}
        />
      ));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(requested.map((request) => request.id).sort()).toEqual(["brief", "broken"]);
      // A stable address (no per-request replica), so the browser revalidates by ETag.
      for (const request of requested) expect(request.options).toBeUndefined();
      const pictures = container.querySelectorAll<HTMLImageElement>("img");
      expect(pictures).toHaveLength(1);
      const src = pictures[0]!.getAttribute("src")!;
      expect(src).toStartWith("data:image/svg+xml;charset=utf-8,");
      expect(decodeURIComponent(src)).toContain("<text>Project brief</text>");
      const broken = Array.from(container.querySelectorAll("ul[aria-label=Artifacts] > li")).find(
        (li) => li.textContent?.includes("Old notes"),
      )!;
      expect(broken.querySelector("img")).toBeNull();
      expect(broken.querySelector("svg")).not.toBeNull();
      // Remounting the cards doesn't redraw a picture that just failed (or one already drawn).
      await act(async () => root.unmount());
      const again = createRoot(container);
      await renderInRouter(again, () => (
        <ArtifactLibrary
          workspaceId="workspace"
          items={documents}
          filters={defaultArtifactFilters}
          onFiltersChange={() => {}}
          loading={false}
          onRetry={() => {}}
        />
      ));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(requested).toHaveLength(2);
      await act(async () => again.unmount());
    } finally {
      container.remove();
    }
  });
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
    expect(cards[0]!.textContent).toContain("App · updated");
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

test("shared library lists the type as a word and never executes apps", async () => {
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
    expect(rows()[1]!.textContent).toContain("App");
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

test("pinned markers remain visible in both gallery and list without adding an action for read-only viewers", async () => {
  localStorage.removeItem("opengeni:artifact-library:view:v1");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await renderInRouter(root, () => (
      <ArtifactLibrary
        workspaceId="workspace"
        items={[{ ...items[1]!, pinned: true }, items[0]!]}
        filters={defaultArtifactFilters}
        onFiltersChange={() => {}}
        loading={false}
        onRetry={() => {}}
      />
    ));
    expect(container.querySelectorAll('[title="Pinned"]')).toHaveLength(1);
    expect(container.querySelector('[title="Pinned"]')?.textContent).toBe("Pinned");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="List"]')!.click(),
    );
    expect(container.querySelectorAll('[title="Pinned"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="list-row"]')).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    localStorage.removeItem("opengeni:artifact-library:view:v1");
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
          new Error("Opengeni API 503: upstream unavailable Reference: req_503."),
          { status: 503 },
        )}
      />
    ));
    expect(container.textContent).toContain("Couldn't load artifacts");
    expect(container.textContent).toContain("Try again in a moment.");
    expect(container.textContent).not.toContain("Opengeni API");
    expect(container.textContent).not.toContain("req_503");
    await renderInRouter(root, () => (
      <ArtifactLibrary
        {...props}
        loading={false}
        error={Object.assign(
          new Error("Opengeni API 403: missing permission: artifacts:read Reference: req_403."),
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

test("hidden apps and documents are explained instead of reported as missing", async () => {
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
    // A Sites tab without artifacts:read is a permission gap, never "No apps yet".
    await renderInRouter(root, () => (
      <ArtifactLibrary
        {...props}
        items={[]}
        filters={{ ...defaultArtifactFilters, kind: "site" }}
      />
    ));
    expect(container.textContent).toContain("You can't see apps here.");
    expect(container.textContent).toContain(access);
    expect(container.textContent).not.toContain("No apps yet");
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
    expect(container.textContent).toContain("Apps and documents are hidden");
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
    // A stale grant never hides what the server returned.
    const site: ArtifactCatalogItem = { ...file, id: "site", kind: "site", title: "Status board" };
    await renderInRouter(root, () => (
      <ArtifactLibrary
        {...props}
        items={[site]}
        filters={{ ...defaultArtifactFilters, kind: "site" }}
      />
    ));
    expect(container.textContent).toContain("Status board");
    expect(container.textContent).not.toContain(access);
    await renderInRouter(root, () => (
      <ArtifactLibrary {...props} items={[file, site]} filters={defaultArtifactFilters} />
    ));
    expect(container.textContent).not.toContain("Apps and documents are hidden");
    // A viewer who can read artifacts sees no notice.
    await renderInRouter(root, () => (
      <ArtifactLibrary
        {...props}
        artifactKindsHidden={false}
        items={[]}
        filters={{ ...defaultArtifactFilters, kind: "site" }}
      />
    ));
    expect(container.textContent).toContain("No apps yet.");
    expect(container.textContent).not.toContain(access);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Only me files and images are marked in the gallery and the list; shared ones are not", async () => {
  localStorage.removeItem("opengeni:artifact-library:view:v1");
  const files: ArtifactCatalogItem[] = [
    {
      id: "private-file",
      kind: "file",
      title: "draft.pdf",
      status: "active",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-02T00:00:00Z",
      visibility: "private",
      ownedByViewer: true,
    },
    {
      id: "shared-file",
      kind: "file",
      title: "final.pdf",
      status: "active",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      visibility: "workspace",
      ownedByViewer: false,
    },
  ];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await renderInRouter(root, () => (
      <ArtifactLibrary
        workspaceId="workspace"
        items={files}
        filters={defaultArtifactFilters}
        onFiltersChange={() => {}}
        loading={false}
        onRetry={() => {}}
      />
    ));
    const entries = () => [...container.querySelectorAll("ul[aria-label=Artifacts] > li")];
    const marked = () =>
      entries().map((entry) => [
        entry.textContent?.includes("draft.pdf") ? "draft" : "final",
        entry.textContent?.includes("Only me") ?? false,
      ]);
    expect(Object.fromEntries(marked())).toEqual({ draft: true, final: false });
    const list = container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="List"]');
    await act(async () => list!.click());
    expect(Object.fromEntries(marked())).toEqual({ draft: true, final: false });
  } finally {
    await act(async () => root.unmount());
    localStorage.removeItem("opengeni:artifact-library:view:v1");
    container.remove();
  }
});

test("Only me documents and spreadsheets are marked in the list; shared ones are not", async () => {
  localStorage.setItem("opengeni:artifact-library:view:v1", "list");
  const documents: ArtifactCatalogItem[] = [
    {
      id: "a".repeat(32),
      kind: "document",
      title: "Private plan",
      status: "active",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-02T00:00:00Z",
      visibility: "private",
      ownedByViewer: true,
    },
    {
      id: "b".repeat(32),
      kind: "spreadsheet",
      title: "Team budget",
      status: "active",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      visibility: "workspace",
      ownedByViewer: false,
    },
  ];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await renderInRouter(root, () => (
      <ArtifactLibrary
        workspaceId="workspace"
        items={documents}
        filters={defaultArtifactFilters}
        onFiltersChange={() => {}}
        loading={false}
        onRetry={() => {}}
      />
    ));
    const marked = [...container.querySelectorAll("ul[aria-label=Artifacts] > li")].map((entry) => [
      entry.textContent?.includes("Private plan") ? "plan" : "budget",
      entry.textContent?.includes("Only me") ?? false,
    ]);
    expect(Object.fromEntries(marked)).toEqual({ plan: true, budget: false });
  } finally {
    await act(async () => root.unmount());
    localStorage.removeItem("opengeni:artifact-library:view:v1");
    container.remove();
  }
});

test("an app in the Artifacts list opens in the app view; other artifacts keep their page", async () => {
  localStorage.setItem("opengeni:artifact-library:view:v1", "list");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <ArtifactLibrary
          workspaceId="workspace"
          items={items}
          filters={defaultArtifactFilters}
          onFiltersChange={() => {}}
          loading={false}
          onRetry={() => {}}
          browseSearch={{ browse: true, q: "plan" }}
        />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  try {
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    const link = (title: string) =>
      [...container.querySelectorAll<HTMLAnchorElement>("a[href]")].find((anchor) =>
        anchor.textContent?.includes(title),
      )!;
    // An app opens on its own page, the same however it's opened.
    expect(link("Status board").getAttribute("href")).toBe("/workspaces/workspace/apps/same");
    expect(link("Project brief").getAttribute("href")).toContain(
      "/workspaces/workspace/artifacts/editable/same?",
    );
    await act(async () => link("Status board").click());
    expect(router.state.location.pathname).toBe("/workspaces/workspace/apps/same");
  } finally {
    localStorage.removeItem("opengeni:artifact-library:view:v1");
    await act(async () => root.unmount());
    container.remove();
  }
});
