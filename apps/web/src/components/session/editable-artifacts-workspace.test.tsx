import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";

mock.module("@/routes/editable-artifact", () => ({
  EditableArtifactRoute: () => null,
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
