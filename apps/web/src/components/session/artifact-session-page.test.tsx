import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactSessionPage } from "./artifact-session-page";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

test("full-page close returns to the originating session without relying on browser history", async () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const route = createRootRoute({
    component: () => (
      <ArtifactSessionPage workspaceId={workspaceId} fromSession={sessionId}>
        <div>Full-page Site</div>
      </ArtifactSessionPage>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/artifacts/site?fromSession=" + sessionId] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    const link = container.querySelector("a")!;
    expect(link.textContent).toContain("Back to session");
    expect(link.getAttribute("href")).toBe(`/workspaces/${workspaceId}/sessions/${sessionId}`);
    await act(async () => {
      link.click();
    });
    expect(router.state.location.pathname).toBe(`/workspaces/${workspaceId}/sessions/${sessionId}`);
    await act(async () => {
      root.render(
        <ArtifactSessionPage workspaceId={workspaceId}>
          <div>Standalone Site</div>
        </ArtifactSessionPage>,
      );
    });
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("Standalone Site");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
