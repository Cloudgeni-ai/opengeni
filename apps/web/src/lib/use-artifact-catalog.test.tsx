import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactCatalogItem, ArtifactCatalogListResponse } from "@opengeni/sdk";
import { defaultArtifactFilters } from "./artifact-catalog";
import { useArtifactCatalog } from "./use-artifact-catalog";

type Request = {
  workspaceId: string;
  resolve: (result: ArtifactCatalogListResponse) => void;
  reject: (error: unknown) => void;
};
let requests: Request[] = [];
let accessKeyVersion = 0;
const client = {
  listArtifactCatalog: (workspaceId: string) =>
    new Promise<ArtifactCatalogListResponse>((resolve, reject) =>
      requests.push({ workspaceId, resolve, reject }),
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
function Probe({ workspaceId, q = "" }: { workspaceId: string; q?: string }) {
  catalog = useArtifactCatalog(
    client,
    workspaceId,
    { ...defaultArtifactFilters, q },
    accessKeyVersion,
  );
  return <div>{catalog.items.map((entry) => entry.title).join(",")}</div>;
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
