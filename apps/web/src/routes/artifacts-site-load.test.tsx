import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";

const SITE_ID = "dc24100a-e408-4713-9c12-ef41e3964f6a";
const WORKSPACE_ID = "5d929faa-c755-4146-9d60-e55f42251f0d";
const SESSION_ID = "cf39f8d3-673f-43c0-9f98-c2787fdcf84e";

let loadError: unknown = null;

mock.module("@opengeni/react/sites", () => ({
  loadSiteSnapshot: async () => {
    if (loadError) throw loadError;
    return {
      detail: {
        artifact: {
          id: SITE_ID,
          workspaceId: WORKSPACE_ID,
          accountId: "org",
          slug: "cafe",
          title: "Café menu",
          description: null,
          status: "active",
          currentVersion: {
            id: "current",
            revision: 1,
            sizeBytes: 12,
            createdAt: "2026-09-15T00:00:00Z",
            sourceSizeBytes: null,
            sourceSessionId: null,
          },
          createdBySubjectId: "owner",
          createdAt: "2026-09-15T00:00:00Z",
          updatedAt: "2026-09-15T00:00:00Z",
        },
        versions: [],
        events: [],
        versionsTruncated: false,
        eventsTruncated: false,
      },
      version: { id: "current" },
      content: {
        artifactId: SITE_ID,
        versionId: "current",
        contentType: "text/html",
        html: "<p>Café</p>",
        requestedTools: [],
      },
    };
  },
}));

mock.module("@/lib/site-tool-bridge", () => ({
  createSiteToolBridge: () => undefined,
}));

mock.module("@/context", () => ({
  useAppContext: () => ({
    client: {
      tools: {
        forWorkspace: () => ({ list: async () => [] }),
      },
    },
    accessContext: {
      workspaceGrants: [{ workspaceId: WORKSPACE_ID, permissions: ["artifacts:publish"] }],
    },
    busy: false,
    startSession: async () => null,
    authSession: null,
  }),
}));

mock.module("@/components/artifacts/site-conversations", () => ({
  SiteConversations: () => <button type="button">Conversations</button>,
}));

mock.module("@/components/artifacts/artifact-sandbox", () => ({
  ArtifactSandbox: () => <div data-sandbox>sandbox</div>,
}));

mock.module("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));

const { ArtifactDetailRoute } = await import("./artifacts");

beforeAll(() => {
  GlobalRegistrator.register({ url: "https://example.test" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  loadError = null;
});

async function renderDetail() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const route = createRootRoute({
    component: () => (
      <ArtifactDetailRoute
        workspaceId={WORKSPACE_ID}
        artifactId={SITE_ID}
        fromSession={SESSION_ID}
      />
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

function hasAction(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].some(
    (node) => (node.textContent ?? "").replace(/\s+/g, " ").trim() === label,
  );
}

test("Site mutations stay hidden until a valid detail loads", async () => {
  const { container, root } = await renderDetail();
  try {
    expect(hasAction(container, "Archive")).toBe(true);
    expect(hasAction(container, "Edit with Geni")).toBe(true);
    expect(hasAction(container, "Conversations")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Site load errors hide Archive and Edit with Geni without leaking API status", async () => {
  loadError = new OpenGeniApiError(404, "", { correlationId: "req_site-1" });
  const { container, root } = await renderDetail();
  try {
    expect(container.textContent).toContain("isn't available");
    expect(container.textContent).toContain("Reference: req_site-1");
    expect(container.textContent).not.toContain("OpenGeni API");
    expect(hasAction(container, "Archive")).toBe(false);
    expect(hasAction(container, "Edit with Geni")).toBe(false);
    expect(hasAction(container, "Conversations")).toBe(false);
    expect(hasAction(container, "Retry")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("malformed Site links hide mutations and do not offer retry", async () => {
  loadError = new OpenGeniApiError(422, "");
  const { container, root } = await renderDetail();
  try {
    expect(container.textContent).toContain("This Site link isn't valid");
    expect(hasAction(container, "Archive")).toBe(false);
    expect(hasAction(container, "Edit with Geni")).toBe(false);
    expect(hasAction(container, "Retry")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("transient Site load failures keep retry and hide mutations", async () => {
  loadError = new OpenGeniApiError(503, "", { correlationId: "req_site-2" });
  const { container, root } = await renderDetail();
  try {
    expect(container.textContent).toContain("Couldn't load this Site");
    expect(container.textContent).toContain("Reference: req_site-2");
    expect(hasAction(container, "Archive")).toBe(false);
    expect(hasAction(container, "Edit with Geni")).toBe(false);
    expect(hasAction(container, "Retry")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
