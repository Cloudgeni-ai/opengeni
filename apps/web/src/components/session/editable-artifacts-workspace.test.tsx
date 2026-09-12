import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

mock.module("@/routes/editable-artifact", () => ({
  EditableArtifactRoute: () => null,
}));
mock.module("@/routes/artifacts", () => ({
  ArtifactDetailRoute: ({ artifactId, embedded }: { artifactId: string; embedded?: boolean }) => (
    <div data-site-preview={artifactId}>{embedded ? "Embedded Site" : "Full Site"}</div>
  ),
}));

const { SessionEditableArtifactsWorkspace } = await import("./editable-artifacts-workspace");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("SessionEditableArtifactsWorkspace empty states", () => {
  test("catalog discovery stays in browse mode and a kind-qualified document request cannot select a colliding Site", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const selections: (string | null)[] = [];
    const catalogItems = (["site", "document"] as const).map((kind) => ({
      id,
      kind,
      title: kind === "site" ? "Board" : "Brief",
      status: "active" as const,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    }));
    const route = createRootRoute({
      component: () => {
        const [loaded, setLoaded] = useState(false);
        const [request, setRequest] = useState<{
          artifactId: string;
          artifactKind: "document";
          requestId: number;
        } | null>(null);
        return (
          <>
            <button data-discover onClick={() => setLoaded(true)}>
              Discover
            </button>
            <button
              data-open-document
              onClick={() => setRequest({ artifactId: id, artifactKind: "document", requestId: 1 })}
            >
              Open document
            </button>
            <SessionEditableArtifactsWorkspace
              workspaceId="workspace"
              artifacts={
                loaded
                  ? catalogItems.map((item) => ({
                      id,
                      title: item.title,
                      modality: item.kind,
                      catalogItem: item,
                    }))
                  : []
              }
              status={loaded ? "ready" : "loading"}
              onRetry={() => {}}
              onSelectedArtifactIdChange={(selectedId) => selections.push(selectedId)}
              openArtifactRequest={request}
            />
          </>
        );
      },
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        await router.load();
        root.render(<RouterProvider router={router} />);
      });
      await act(async () =>
        (container.querySelector("[data-discover]") as HTMLButtonElement).click(),
      );
      expect(container.textContent).toContain("Session artifacts");
      expect(container.querySelector("[data-site-preview]")).toBeNull();
      expect(selections).toEqual([]);
      await act(async () =>
        (container.querySelector("[data-open-document]") as HTMLButtonElement).click(),
      );
      expect(
        (container.querySelector('[aria-label="Choose artifact"]') as HTMLSelectElement).value,
      ).toBe(`document:${id}`);
      expect(container.querySelector("[data-site-preview]")).toBeNull();
      expect(selections).toEqual([`document:${id}`]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  test("replaced synthetic Sites win over fallback and handled requests preserve manual selection", async () => {
    const discovered = "22222222-2222-4222-8222-222222222222";
    const first = "44444444-4444-4444-8444-444444444444";
    const second = "55555555-5555-4555-8555-555555555555";
    const selections: string[] = [];
    const route = createRootRoute({
      component: () => {
        const [request, setRequest] = useState({ artifactId: first, requestId: 1 });
        const [, rerender] = useState(0);
        return (
          <>
            <button
              data-open
              onClick={() => setRequest({ artifactId: second, requestId: request.requestId + 1 })}
            >
              Open Site
            </button>
            <button data-refresh onClick={() => rerender((value) => value + 1)}>
              Refresh
            </button>
            <SessionEditableArtifactsWorkspace
              workspaceId="11111111-1111-4111-8111-111111111111"
              artifacts={[
                { id: discovered, title: "Discovered", modality: "site" },
                { id: request.artifactId, title: "Linked Site", modality: "site" },
              ]}
              status="ready"
              onRetry={() => undefined}
              openArtifactRequest={{ ...request }}
              onSelectedArtifactIdChange={(id) => {
                if (id) selections.push(id);
              }}
            />
          </>
        );
      },
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const selected = () =>
      container.querySelector("[data-site-preview]")?.getAttribute("data-site-preview");
    try {
      await act(async () => {
        await router.load();
        root.render(<RouterProvider router={router} />);
      });
      expect(selected()).toBe(first);
      await act(async () => (container.querySelector("[data-open]") as HTMLButtonElement).click());
      expect(selected()).toBe(second);
      expect(selections).toEqual([first, second]);
      await act(async () => {
        const select = container.querySelector("select")!;
        select.value = discovered;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () =>
        (container.querySelector("[data-refresh]") as HTMLButtonElement).click(),
      );
      expect(selected()).toBe(discovered);
      expect(selections).toEqual([first, second, discovered]);
      await act(async () => (container.querySelector("[data-open]") as HTMLButtonElement).click());
      expect(selected()).toBe(second);
      expect(selections).toEqual([first, second, discovered, second]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  test("chat requests switch an already mounted viewer and can reopen the same Site", async () => {
    const first = "22222222-2222-4222-8222-222222222222";
    const second = "44444444-4444-4444-8444-444444444444";
    const route = createRootRoute({
      component: () => {
        const [request, setRequest] = useState<{ artifactId: string; requestId: number } | null>(
          null,
        );
        return (
          <>
            <button
              onClick={() =>
                setRequest({ artifactId: second, requestId: (request?.requestId ?? 0) + 1 })
              }
            >
              Open linked Site
            </button>
            <SessionEditableArtifactsWorkspace
              workspaceId="11111111-1111-4111-8111-111111111111"
              artifacts={[
                { id: first, title: "First", modality: "site" },
                { id: second, title: "Second", modality: "site" },
              ]}
              status="ready"
              onRetry={() => undefined}
              openArtifactRequest={request}
            />
          </>
        );
      },
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        await router.load();
        root.render(<RouterProvider router={router} />);
      });
      expect(
        container.querySelector("[data-site-preview]")?.getAttribute("data-site-preview"),
      ).toBe(first);
      await act(async () => container.querySelector("button")!.click());
      expect(
        container.querySelector("[data-site-preview]")?.getAttribute("data-site-preview"),
      ).toBe(second);
      await act(async () => {
        const select = container.querySelector("select")!;
        select.value = first;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(
        container.querySelector("[data-site-preview]")?.getAttribute("data-site-preview"),
      ).toBe(first);
      await act(async () => container.querySelector("button")!.click());
      expect(
        container.querySelector("[data-site-preview]")?.getAttribute("data-site-preview"),
      ).toBe(second);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  test("opens a session Site in the shared preview with a full-page link", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const id = "22222222-2222-4222-8222-222222222222";
    const route = createRootRoute({
      component: () => (
        <SessionEditableArtifactsWorkspace
          workspaceId="11111111-1111-4111-8111-111111111111"
          sessionId="33333333-3333-4333-8333-333333333333"
          artifacts={[{ id, title: "Dashboard", modality: "site" }]}
          status="ready"
          onRetry={() => undefined}
        />
      ),
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    try {
      await act(async () => {
        await router.load();
        root.render(<RouterProvider router={router} />);
      });
      expect(
        container.querySelector("[data-site-preview]")?.getAttribute("data-site-preview"),
      ).toBe(id);
      expect(container.textContent).toContain("Embedded Site");
      expect(container.querySelector("a")?.getAttribute("href")).toBe(
        `/workspaces/11111111-1111-4111-8111-111111111111/artifacts/${id}?fromSession=33333333-3333-4333-8333-333333333333`,
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  test("restores and reports the selected artifact", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSelectionChange = mock(() => undefined);
    const firstId = "a".repeat(32);
    const secondId = "b".repeat(32);
    const route = createRootRoute({
      component: () => (
        <SessionEditableArtifactsWorkspace
          workspaceId="11111111-1111-4111-8111-111111111111"
          artifacts={[
            { id: firstId, modality: "document", title: "Plan" },
            { id: secondId, modality: "spreadsheet", title: "Budget" },
          ]}
          status="ready"
          onRetry={() => undefined}
          initialSelectedArtifactId={secondId}
          onSelectedArtifactIdChange={onSelectionChange}
        />
      ),
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    try {
      await act(async () => {
        await router.load();
        root.render(<RouterProvider router={router} />);
      });
      const select = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Choose artifact"]',
      );
      expect(select?.value).toBe(secondId);

      await act(async () => {
        if (!select) return;
        select.value = firstId;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(onSelectionChange).toHaveBeenCalledWith(firstId);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps the first-class artifact surface discoverable before one exists", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <SessionEditableArtifactsWorkspace
            workspaceId="11111111-1111-4111-8111-111111111111"
            artifacts={[]}
            status="ready"
            onRetry={() => undefined}
          />,
        );
      });

      expect(container.textContent).toContain("No artifacts yet");
      expect(container.textContent).toContain("Ask the agent to create or import");
      expect(container.querySelector("button")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("reports loading and offers an explicit retry after failure", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onRetry = mock(() => undefined);

    try {
      await act(async () => {
        root.render(
          <SessionEditableArtifactsWorkspace
            workspaceId="11111111-1111-4111-8111-111111111111"
            artifacts={[]}
            status="loading"
            onRetry={onRetry}
          />,
        );
      });
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        "Loading artifacts",
      );

      await act(async () => {
        root.render(
          <SessionEditableArtifactsWorkspace
            workspaceId="11111111-1111-4111-8111-111111111111"
            artifacts={[]}
            status="error"
            onRetry={onRetry}
          />,
        );
      });
      const retry = container.querySelector<HTMLButtonElement>("button");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Artifacts unavailable",
      );
      expect(retry?.textContent).toContain("Try again");
      await act(async () => retry?.click());
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps a known artifact usable while exposing a list refresh failure", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onRetry = mock(() => undefined);
    const route = createRootRoute({
      component: () => (
        <SessionEditableArtifactsWorkspace
          workspaceId="11111111-1111-4111-8111-111111111111"
          artifacts={[{ id: "a".repeat(32), modality: "document", title: "Plan" }]}
          status="error"
          onRetry={onRetry}
        />
      ),
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    try {
      await act(async () => {
        await router.load();
        root.render(<RouterProvider router={router} />);
      });

      expect(container.textContent).toContain("Plan");
      const retry = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Retry artifact list"]',
      );
      expect(retry).not.toBeNull();
      await act(async () => retry?.click());
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
