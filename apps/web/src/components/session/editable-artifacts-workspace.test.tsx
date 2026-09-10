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
