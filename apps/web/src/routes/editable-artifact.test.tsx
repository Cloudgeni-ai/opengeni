import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
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
let loadError: unknown = new Error("Fixture unavailable");
const workspaceId = "5d929faa-c755-4146-9d60-e55f42251f0d";
const fromSession = "cf39f8d3-673f-43c0-9f98-c2787fdcf84e";
const artifactId = "d10307ab68064d36855af499c9e3ccc7";
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
      if (state === "error") throw loadError;
      return { modality, title: `Native ${modality}` };
    },
  },
}));
mock.module("@opengeni/sdk/editable-artifacts/worker?worker&url", () => ({ default: "worker.js" }));
mock.module("@opengeni/react/artifacts", () => ({
  BrowserEditableArtifactWorkbench: ({
    document,
    spreadsheet,
    presentation,
  }: {
    document: { title: string; showHeader: boolean };
    spreadsheet: { showHeader: boolean };
    presentation: { showHeader: boolean };
  }) => (
    <h1
      data-document-header={String(document.showHeader)}
      data-spreadsheet-header={String(spreadsheet.showHeader)}
      data-presentation-header={String(presentation.showHeader)}
    >
      {document.title}
    </h1>
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
              artifactId={artifactId}
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
            expect(links[0]!.getAttribute("href")).toBe(
              `/workspaces/${workspaceId}/artifacts?fromSession=${fromSession}`,
            );
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
          if (loadState === "ready") {
            const workbench = container.querySelector("h1")!;
            for (const attribute of [
              "data-document-header",
              "data-spreadsheet-header",
              "data-presentation-header",
            ]) {
              expect(workbench.getAttribute(attribute)).toBe(String(!embedded));
            }
          }
          if (loadState === "error" && !embedded) {
            expect(container.textContent).toContain("Try again");
            expect(container.textContent).not.toMatch(/OpenGeni API/i);
            expect(container.textContent).not.toContain("Fixture unavailable");
          }
        } finally {
          await act(async () => root.unmount());
          container.remove();
        }
      });
    }
  }
}

for (const [status, title, retry] of [
  [404, "This artifact isn't available", false],
  [403, "This artifact isn't available", false],
  [422, "This artifact link isn't valid", false],
  [503, "Could not open this artifact", true],
] as const) {
  test(`full-page ${status} uses friendly copy without leaking API status`, async () => {
    state = "error";
    loadError = new OpenGeniApiError(status, "", {
      ...(status === 503 ? { retryable: true, correlationId: "req_edit-1" } : {}),
    });
    const { EditableArtifactRoute } = await import("./editable-artifact");
    const route = createRootRoute({
      component: () => (
        <EditableArtifactRoute
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
      expect(container.textContent).toContain(title);
      expect(container.textContent?.includes("Try again")).toBe(retry);
      expect(container.textContent).not.toMatch(/OpenGeni API/i);
      expect(container.textContent).not.toContain(String(status));
      if (status === 503) expect(container.textContent).toContain("Reference: req_edit-1");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
