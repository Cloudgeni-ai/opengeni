import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactCatalogItem, ArtifactCatalogListResponse } from "@opengeni/sdk";
import { defaultArtifactFilters } from "./artifact-catalog";
import { expireArtifactCatalog } from "./artifact-catalog-cache";
import { invalidateArtifactCatalog, useArtifactCatalog } from "./use-artifact-catalog";
import { useArtifactCatalogMutationInvalidation } from "./use-artifact-catalog-mutation-invalidation";

type Request = {
  workspaceId: string;
  cursor?: string;
  q?: string;
  resolve: (result: ArtifactCatalogListResponse) => void;
  reject: (error: unknown) => void;
};
let requests: Request[] = [];
let accessKeyVersion = 0;
const client = {
  listArtifactCatalog: (workspaceId: string, options: { cursor?: string; q?: string } = {}) =>
    new Promise<ArtifactCatalogListResponse>((resolve, reject) =>
      requests.push({ workspaceId, cursor: options.cursor, q: options.q, resolve, reject }),
    ),
};
let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
beforeAll(() => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register();
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
const item = (title: string): ArtifactCatalogItem => ({
  id: title,
  title,
  kind: "site",
  status: "active",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
});
let catalog: ReturnType<typeof useArtifactCatalog>;
let invalidateAfterMutation: () => void;
function Probe({
  workspaceId,
  q = "",
  kind = "all",
  catalogClient = client,
  invalidate = invalidateArtifactCatalog,
  retainedPages = 1,
}: {
  workspaceId: string;
  q?: string;
  kind?: "all" | "site";
  catalogClient?: typeof client;
  invalidate?: typeof invalidateArtifactCatalog;
  retainedPages?: number;
}) {
  catalog = useArtifactCatalog(
    catalogClient,
    workspaceId,
    { ...defaultArtifactFilters, q, kind },
    accessKeyVersion,
    retainedPages,
  );
  invalidateAfterMutation = useArtifactCatalogMutationInvalidation(
    catalogClient,
    workspaceId,
    invalidate,
  );
  return <div>{catalog.items.map((entry) => entry.title).join(",")}</div>;
}

test("a returning library reloads its retained page count after cache invalidation", async () => {
  requests = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspaceId="retained-pages" retainedPages={3} />));
    await act(async () => requests[0]!.resolve({ items: [item("First")], nextCursor: "two" }));
    expect(requests[1]!.cursor).toBe("two");
    await act(async () => requests[1]!.resolve({ items: [], nextCursor: "three" }));
    expect(requests[2]!.cursor).toBe("three");
    await act(async () => requests[2]!.resolve({ items: [item("Third")], nextCursor: "four" }));
    expect(catalog.items.map((entry) => entry.title)).toEqual(["First", "Third"]);
    expect(catalog.pages).toBe(3);
    expect(catalog.nextCursor).toBe("four");
    expect(requests).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("mutation refresh can be awaited while retry remains a non-blocking event handler", async () => {
  requests = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspaceId="pin-refresh" />));
    await act(async () => requests[0]!.resolve({ items: [item("Before")], nextCursor: null }));
    let completed = false;
    let refresh: Promise<void>;
    await act(async () => {
      refresh = catalog.refresh().then(() => {
        completed = true;
      });
    });
    expect(completed).toBe(false);
    expect(requests).toHaveLength(2);
    await act(async () => {
      requests[1]!.resolve({ items: [{ ...item("After"), pinned: true }], nextCursor: null });
      await refresh;
    });
    expect(completed).toBe(true);
    expect(catalog.items[0]?.pinned).toBe(true);
    await act(async () => {
      expect(catalog.retry()).toBeUndefined();
    });
    await act(async () => requests[2]!.resolve({ items: [item("Retried")], nextCursor: null }));
    expect(container.textContent).toBe("Retried");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

for (const change of ["filters", "authority", "client"] as const) {
  test(`a delayed pin save refreshes the latest ${change} without stranding its request`, async () => {
    requests = [];
    accessKeyVersion = 0;
    const workspaceId = `delayed-pin-${change}`;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Probe workspaceId={workspaceId} />));
      await act(async () => requests[0]!.resolve({ items: [item("Before")], nextCursor: null }));
      const beforeSave = catalog;
      const invalidateSavedMutation = invalidateAfterMutation;
      let resolveSave!: () => void;
      const saved = new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
      const finished = saved.then(async () => {
        invalidateSavedMutation();
        await beforeSave.refresh();
      });
      const nextClient = change === "client" ? { ...client } : client;
      const nextQuery = change === "filters" ? "current" : "";
      if (change === "authority") accessKeyVersion++;
      await act(async () =>
        root.render(<Probe workspaceId={workspaceId} q={nextQuery} catalogClient={nextClient} />),
      );
      expect(requests).toHaveLength(2);
      await act(async () => resolveSave());
      expect(requests).toHaveLength(3);
      expect(requests[2]!.q).toBe(nextQuery || undefined);
      await act(async () =>
        requests[1]!.resolve({ items: [item("Pre-save response")], nextCursor: null }),
      );
      await act(async () => {
        requests[2]!.resolve({
          items: [{ ...item("Current pinned"), pinned: true }],
          nextCursor: null,
        });
        await finished;
      });
      expect(container.textContent).toBe("Current pinned");
      expect(catalog.loading).toBe(false);
      expect(catalog.error).toBeNull();
      expect(catalog.items[0]?.pinned).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}

test("obsolete retry and pagination callbacks cannot invalidate the current view", async () => {
  requests = [];
  accessKeyVersion = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  try {
    await act(async () => root.render(<Probe workspaceId="stale-callbacks" />));
    await act(async () => requests[0]!.resolve({ items: [item("Old")], nextCursor: "old-page" }));
    const stale = catalog;
    await act(async () => root.render(<Probe workspaceId="stale-callbacks" q="current" />));
    await act(async () => {
      stale.retry();
      stale.loadMore();
    });
    expect(requests).toHaveLength(2);
    await act(async () => requests[1]!.resolve({ items: [item("Current")], nextCursor: null }));
    expect(container.textContent).toBe("Current");
    expect(catalog.loading).toBe(false);
    await act(async () => root.unmount());
    mounted = false;
    await stale.refresh();
    stale.retry();
    stale.loadMore();
    expect(requests).toHaveLength(2);
  } finally {
    if (mounted) await act(async () => root.unmount());
    container.remove();
  }
});

for (const [mode, invalidate] of [
  ["workspace invalidation", invalidateArtifactCatalog],
  ["session expiration", expireArtifactCatalog],
] as const) {
  test(`a delayed pin save updates every latest-client filtered cache via ${mode}`, async () => {
    requests = [];
    accessKeyVersion = 0;
    const workspaceId = `delayed-pin-client-filters-${mode}`;
    const nextClient = { ...client };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<Probe workspaceId={workspaceId} invalidate={invalidate} />),
      );
      await act(async () => requests[0]!.resolve({ items: [item("Before")], nextCursor: null }));
      const beforeSave = catalog;
      const invalidateSavedMutation = invalidateAfterMutation;
      let resolveSave!: () => void;
      const saved = new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
      const finished = saved.then(async () => {
        invalidateSavedMutation();
        await beforeSave.refresh();
      });
      await act(async () =>
        root.render(
          <Probe
            workspaceId={workspaceId}
            kind="site"
            catalogClient={nextClient}
            invalidate={invalidate}
          />,
        ),
      );
      await act(async () =>
        requests[1]!.resolve({ items: [{ ...item("Sites"), pinned: false }], nextCursor: null }),
      );
      await act(async () =>
        root.render(
          <Probe workspaceId={workspaceId} catalogClient={nextClient} invalidate={invalidate} />,
        ),
      );
      await act(async () =>
        requests[2]!.resolve({ items: [{ ...item("All"), pinned: false }], nextCursor: null }),
      );
      await act(async () => resolveSave());
      expect(requests).toHaveLength(4);
      await act(async () => {
        requests[3]!.resolve({ items: [{ ...item("All"), pinned: true }], nextCursor: null });
        await finished;
      });
      expect(catalog.items[0]?.pinned).toBe(true);
      await act(async () =>
        root.render(
          <Probe
            workspaceId={workspaceId}
            kind="site"
            catalogClient={nextClient}
            invalidate={invalidate}
          />,
        ),
      );
      expect(catalog.loading).toBe(true);
      expect(requests).toHaveLength(5);
      await act(async () =>
        requests[4]!.resolve({ items: [{ ...item("Sites"), pinned: true }], nextCursor: null }),
      );
      expect(catalog.items[0]?.pinned).toBe(true);
      expect(catalog.loading).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test(`a delayed save preserves unrelated workspace caches via ${mode}`, async () => {
    requests = [];
    accessKeyVersion = 0;
    const workspaceId = `mutation-scope-${mode}`;
    const otherWorkspaceId = `${workspaceId}-other`;
    const nextClient = { ...client };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<Probe workspaceId={workspaceId} invalidate={invalidate} />),
      );
      await act(async () =>
        requests[0]!.resolve({ items: [item("Saved workspace")], nextCursor: null }),
      );
      const invalidateSavedMutation = invalidateAfterMutation;
      await act(async () =>
        root.render(<Probe workspaceId={otherWorkspaceId} invalidate={invalidate} />),
      );
      await act(async () =>
        requests[1]!.resolve({ items: [item("Other original client")], nextCursor: null }),
      );
      await act(async () =>
        root.render(
          <Probe
            workspaceId={otherWorkspaceId}
            catalogClient={nextClient}
            invalidate={invalidate}
          />,
        ),
      );
      await act(async () =>
        requests[2]!.resolve({ items: [item("Other latest client")], nextCursor: null }),
      );
      await act(async () =>
        root.render(
          <Probe
            workspaceId={otherWorkspaceId}
            kind="site"
            catalogClient={nextClient}
            invalidate={invalidate}
          />,
        ),
      );
      await act(async () =>
        requests[3]!.resolve({ items: [item("Other latest Sites")], nextCursor: null }),
      );

      invalidateSavedMutation();
      await act(async () =>
        root.render(
          <Probe
            workspaceId={otherWorkspaceId}
            catalogClient={nextClient}
            invalidate={invalidate}
          />,
        ),
      );
      expect(requests).toHaveLength(4);
      expect(catalog.loading).toBe(false);
      expect(container.textContent).toBe("Other latest client");
      await act(async () =>
        root.render(<Probe workspaceId={otherWorkspaceId} invalidate={invalidate} />),
      );
      expect(requests).toHaveLength(4);
      expect(catalog.loading).toBe(false);
      expect(container.textContent).toBe("Other original client");
      await act(async () =>
        root.render(<Probe workspaceId={workspaceId} invalidate={invalidate} />),
      );
      expect(requests).toHaveLength(5);
      expect(catalog.loading).toBe(true);
      await act(async () =>
        requests[4]!.resolve({
          items: [{ ...item("Saved workspace"), pinned: true }],
          nextCursor: null,
        }),
      );
      expect(catalog.items[0]?.pinned).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test(`an unmounted mutation callback ${mode} does not refresh or invalidate another view`, async () => {
    requests = [];
    accessKeyVersion = 0;
    const workspaceId = `mutation-unmounted-${mode}`;
    const nextClient = { ...client };
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    try {
      await act(async () =>
        root.render(<Probe workspaceId={workspaceId} invalidate={invalidate} />),
      );
      await act(async () => requests[0]!.resolve({ items: [item("Original")], nextCursor: null }));
      const invalidateSavedMutation = invalidateAfterMutation;
      const beforeSave = catalog;
      await act(async () =>
        root.render(
          <Probe workspaceId={workspaceId} catalogClient={nextClient} invalidate={invalidate} />,
        ),
      );
      await act(async () => requests[1]!.resolve({ items: [item("Latest")], nextCursor: null }));
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () =>
        root.render(
          <Probe workspaceId={workspaceId} catalogClient={nextClient} invalidate={invalidate} />,
        ),
      );

      await act(async () => {
        invalidateSavedMutation();
        await beforeSave.refresh();
      });
      expect(requests).toHaveLength(2);
      expect(container.textContent).toBe("Latest");
      expect(catalog.loading).toBe(false);
      await act(async () =>
        root.render(
          <Probe
            workspaceId={workspaceId}
            kind="site"
            catalogClient={nextClient}
            invalidate={invalidate}
          />,
        ),
      );
      await act(async () => requests[2]!.resolve({ items: [item("Sites")], nextCursor: null }));
      await act(async () =>
        root.render(
          <Probe workspaceId={workspaceId} catalogClient={nextClient} invalidate={invalidate} />,
        ),
      );
      expect(requests).toHaveLength(3);
      expect(catalog.loading).toBe(false);
      expect(container.textContent).toBe("Latest");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}

test("old workspace, query, and authority responses never replace the current catalog", async () => {
  requests = [];
  accessKeyVersion = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspaceId="old" />));
    await act(async () => root.render(<Probe workspaceId="new" />));
    await act(async () => requests[1]!.resolve({ items: [item("Current")], nextCursor: null }));
    await act(async () =>
      requests[0]!.resolve({ items: [item("Private old workspace")], nextCursor: null }),
    );
    expect(container.textContent).toBe("Current");
    await act(async () => root.render(<Probe workspaceId="new" q="query" />));
    expect(container.textContent).toBe("");
    accessKeyVersion++;
    await act(async () => root.render(<Probe workspaceId="new" q="query" />));
    await act(async () =>
      requests[2]!.resolve({ items: [item("Old authority")], nextCursor: null }),
    );
    expect(container.textContent).toBe("");
    await act(async () => requests[3]!.resolve({ items: [item("Authorized")], nextCursor: null }));
    expect(container.textContent).toBe("Authorized");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("pagination deduplicates native kind IDs and an access denial clears prior results", async () => {
  requests = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspaceId="workspace" />));
    await act(async () => requests[0]!.resolve({ items: [item("First")], nextCursor: "next" }));
    await act(async () => {
      catalog.loadMore();
      catalog.loadMore();
    });
    expect(requests).toHaveLength(2);
    await act(async () =>
      requests[1]!.resolve({
        items: [item("First"), { ...item("First"), kind: "image" }],
        nextCursor: "last",
      }),
    );
    expect(catalog.items).toHaveLength(2);
    await act(async () => catalog.loadMore());
    await act(async () =>
      requests[2]!.reject(Object.assign(new Error("Access denied"), { status: 403 })),
    );
    expect(catalog.items).toEqual([]);
    expect(catalog.error?.message).toBe("Access denied");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("switching tabs and returning to the page reuses complete, still-fresh pages", async () => {
  requests = [];
  accessKeyVersion = 0;
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspaceId="cache-tabs" />));
    await act(async () => requests[0]!.resolve({ items: [item("First")], nextCursor: "next" }));
    await act(async () => catalog.loadMore());
    await act(async () => requests[1]!.resolve({ items: [item("Second")], nextCursor: null }));

    await act(async () => root.render(<Probe workspaceId="cache-tabs" kind="site" />));
    await act(async () => requests[2]!.resolve({ items: [item("Site")], nextCursor: null }));
    await act(async () => root.render(<Probe workspaceId="cache-tabs" />));
    expect(container.textContent).toBe("First,Second");
    expect(requests).toHaveLength(3);

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Probe workspaceId="cache-tabs" kind="site" />));
    expect(container.textContent).toBe("Site");
    expect(requests).toHaveLength(3);

    accessKeyVersion++;
    await act(async () => root.render(<Probe workspaceId="cache-tabs" kind="site" />));
    expect(container.textContent).toBe("");
    expect(requests).toHaveLength(4);
    await act(async () =>
      requests[3]!.resolve({ items: [item("New authority")], nextCursor: null }),
    );
    expect(container.textContent).toBe("New authority");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("transient stale refresh failures keep cached rows and retry can replace them", async () => {
  requests = [];
  accessKeyVersion = 0;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspaceId="cache-transient" />));
    await act(async () => requests[0]!.resolve({ items: [item("Cached")], nextCursor: null }));
    now += 30_001;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => requests[1]!.reject(new TypeError("Failed to fetch")));
    expect(container.textContent).toBe("Cached");
    expect(catalog.error?.message).toBe("Failed to fetch");
    await act(async () => catalog.retry());
    await act(async () => requests[2]!.resolve({ items: [item("Recovered")], nextCursor: null }));
    expect(container.textContent).toBe("Recovered");
  } finally {
    Date.now = originalNow;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("stale catalogs render immediately, refresh on return, and replace removed rows", async () => {
  requests = [];
  accessKeyVersion = 0;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspaceId="cache-stale" />));
    await act(async () => requests[0]!.resolve({ items: [item("Old")], nextCursor: null }));
    now += 30_001;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(requests).toHaveLength(2);
    expect(container.textContent).toBe("Old");
    expect(catalog.loading).toBe(true);
    await act(async () => requests[1]!.resolve({ items: [item("New")], nextCursor: null }));
    expect(container.textContent).toBe("New");
    await act(async () => root.unmount());
    const returnRoot = createRoot(container);
    try {
      now += 30_001;
      await act(async () => returnRoot.render(<Probe workspaceId="cache-stale" />));
      expect(container.textContent).toBe("New");
      expect(requests).toHaveLength(3);
      await act(async () => requests[2]!.resolve({ items: [], nextCursor: null }));
      expect(container.textContent).toBe("");
    } finally {
      await act(async () => returnRoot.unmount());
    }
  } finally {
    Date.now = originalNow;
    container.remove();
  }
});

test("Site mutations invalidate all views and access denials discard cached metadata", async () => {
  requests = [];
  accessKeyVersion = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspaceId="cache-revoked" />));
    await act(async () => requests[0]!.resolve({ items: [item("All")], nextCursor: null }));
    await act(async () => root.render(<Probe workspaceId="cache-revoked" kind="site" />));
    await act(async () => requests[1]!.resolve({ items: [item("Sites")], nextCursor: null }));

    invalidateArtifactCatalog(client, "cache-revoked");
    await act(async () => root.render(<Probe workspaceId="cache-revoked" />));
    expect(container.textContent).toBe("");
    expect(requests).toHaveLength(3);
    await act(async () => requests[2]!.resolve({ items: [item("Updated")], nextCursor: null }));
    await act(async () => root.render(<Probe workspaceId="cache-revoked" kind="site" />));
    await act(async () =>
      requests[3]!.reject(Object.assign(new Error("Access denied"), { status: 403 })),
    );
    await act(async () => root.render(<Probe workspaceId="cache-revoked" />));
    expect(container.textContent).toBe("");
    expect(requests).toHaveLength(5);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a refresh after Load more refetches every shown page instead of collapsing to the first", async () => {
  requests = [];
  accessKeyVersion = 0;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspaceId="cache-pages" />));
    await act(async () => requests[0]!.resolve({ items: [item("A")], nextCursor: "p2" }));
    await act(async () => catalog.loadMore());
    expect(requests[1]!.cursor).toBe("p2");
    await act(async () => requests[1]!.resolve({ items: [item("B")], nextCursor: "p3" }));
    expect(container.textContent).toBe("A,B");

    now += 30_001;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(requests[2]!.cursor).toBeUndefined();
    await act(async () => requests[2]!.resolve({ items: [item("A2")], nextCursor: "q2" }));
    // Still refreshing: the shown rows stay until every page has been refetched.
    expect(container.textContent).toBe("A,B");
    expect(requests[3]!.cursor).toBe("q2");
    await act(async () => requests[3]!.resolve({ items: [item("B2")], nextCursor: "q3" }));
    expect(container.textContent).toBe("A2,B2");
    expect(catalog.nextCursor).toBe("q3");
    expect(requests).toHaveLength(4);

    await act(async () => catalog.loadMore());
    expect(requests[4]!.cursor).toBe("q3");
    await act(async () => requests[4]!.resolve({ items: [item("C2")], nextCursor: null }));
    expect(container.textContent).toBe("A2,B2,C2");
  } finally {
    Date.now = originalNow;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("expiring a workspace keeps cached rows visible and refetches them on the next view", async () => {
  requests = [];
  accessKeyVersion = 0;
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspaceId="cache-expired" />));
    await act(async () => requests[0]!.resolve({ items: [item("Before")], nextCursor: null }));
    await act(async () => root.unmount());

    expireArtifactCatalog(client, "cache-expired");
    root = createRoot(container);
    await act(async () => root.render(<Probe workspaceId="cache-expired" />));
    expect(container.textContent).toBe("Before");
    expect(requests).toHaveLength(2);
    await act(async () =>
      requests[1]!.resolve({ items: [item("Published"), item("Before")], nextCursor: null }),
    );
    expect(container.textContent).toBe("Published,Before");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
