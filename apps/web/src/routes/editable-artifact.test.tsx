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

let state = "ready";
let modality = "document";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const fromSession = "33333333-3333-4333-8333-333333333333";
const context = { accessKeyVersion: 0, accessContext: {}, workspaces: [] };
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("@/lib/editable-artifact-browser", () => ({
  createConsoleEditableArtifactAuthority: async () => ({}),
  createConsoleEditableArtifactReplicaId: () => "1234567890abcdef",
  resolveConsoleEditableArtifactWorkerUrl: () => "https://example.test/worker.js",
}));
mock.module("@/lib/editable-artifact-client", () => ({
  editableArtifactClient: {
    getEditableArtifact: async () => {
      if (state === "loading") return new Promise(() => {});
      if (state === "error") throw new Error("Fixture unavailable");
      return { modality, title: `Native ${modality}` };
    },
  },
}));
mock.module("@opengeni/sdk/editable-artifacts/worker?worker&url", () => ({ default: "worker.js" }));
mock.module("@opengeni/react/artifacts", () => ({
  BrowserEditableArtifactWorkbench: ({ document }: { document: { title: string } }) => (
    <h1>{document.title}</h1>
  ),
}));
beforeAll(() => {
  GlobalRegistrator.register({ url: "https://example.test" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

for (const kind of ["document", "spreadsheet", "presentation"]) {
  for (const loadState of ["ready", "loading", "error"]) {
    for (const embedded of [false, true]) {
      test(`${kind} ${loadState} ${embedded ? "embedded" : "full-page"} navigation`, async () => {
        modality = kind;
        state = loadState;
        const { EditableArtifactRoute } = await import("./editable-artifact");
        const route = createRootRoute({
          component: () => (
            <EditableArtifactRoute
              workspaceId={workspaceId}
              artifactId="artifact"
              fromSession={fromSession}
              embedded={embedded}
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
          const links = [...container.querySelectorAll("a")];
          expect(links.map((link) => link.textContent)).toEqual(
            embedded ? [] : ["All artifacts", "Back to session"],
          );
          if (!embedded) {
            expect(links[0]!.getAttribute("href")).toBe(`/workspaces/${workspaceId}/artifacts`);
            expect(links[1]!.getAttribute("href")).toBe(
              `/workspaces/${workspaceId}/sessions/${fromSession}`,
            );
          }
          expect(container.textContent).toContain(
            loadState === "ready"
              ? `Native ${kind}`
              : loadState === "loading"
                ? "Opening artifact"
                : "Could not open this artifact",
          );
        } finally {
          await act(async () => root.unmount());
          container.remove();
        }
      });
    }
  }
}
