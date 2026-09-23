import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "5d929faa-c755-4146-9d60-e55f42251f0d";
const sessionId = "cf39f8d3-673f-43c0-9f98-c2787fdcf84e";
const artifactId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const context = {
  accessKeyVersion: 0,
  client: {
    getRetainedArtifact: async () => ({ artifactId, available: true, contentType: "text/plain" }),
    getFile: async () => ({ id: artifactId, workspaceId, filename: "notes.txt" }),
  },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
beforeAll(() => {
  GlobalRegistrator.register({ url: "https://example.test" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

for (const fromSession of [undefined, sessionId]) {
  test(`real retained route All artifacts preserves return context ${fromSession ?? "absent"}`, async () => {
    const { RetainedArtifactRoute } = await import("./retained-artifact");
    const route = createRootRoute({
      component: () => (
        <RetainedArtifactRoute
          workspaceId={workspaceId}
          artifactId={artifactId}
          fromSession={fromSession}
        />
      ),
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
      expect(container.textContent).toContain("notes.txt");
      const links = [...container.querySelectorAll("a")].filter((link) =>
        link.textContent?.includes("All artifacts"),
      );
      expect(links).toHaveLength(1);
      const search = fromSession ? `?fromSession=${fromSession}` : "";
      expect(links[0]!.getAttribute("href")).toBe(`/workspaces/${workspaceId}/artifacts${search}`);
      await act(async () => links[0]!.click());
      expect(router.state.location.pathname).toBe(`/workspaces/${workspaceId}/artifacts`);
      expect(router.state.location.searchStr).toBe(search);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
