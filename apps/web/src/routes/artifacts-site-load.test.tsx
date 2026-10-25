import "@/app-host";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement, type ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "5d929faa-c755-4146-9d60-e55f42251f0d";
const siteId = "dc24100a-e408-4713-9c12-ef41e3964f6a";
const versionId = "11111111-1111-4111-8111-111111111111";
const copyId = "22222222-2222-4222-8222-222222222222";

let loadError: unknown = null;
let withoutContent = false;

const snapshot = {
  detail: {
    artifact: {
      id: siteId,
      workspaceId,
      title: "Café menu",
      description: "An interactive workspace Site.",
      status: "active" as const,
      visibility: "private" as const,
      ownerSubjectId: "user:owner",
      currentVersion: { id: versionId, revision: 1, requestedTools: [] },
    },
    versions: [
      {
        id: versionId,
        revision: 1,
        requestedTools: [],
        createdAt: "2026-09-15T00:00:00.000Z",
        sizeBytes: 1024,
      },
    ],
  },
  content: {
    artifactId: siteId,
    versionId,
    html: "<html><body>ok</body></html>",
    requestedTools: [],
  },
};

const siteClient = {
  tools: { forWorkspace: () => ({}) },
  duplicateWorkspaceArtifact: mock(async (..._args: unknown[]) => ({
    artifact: { ...snapshot.detail.artifact, id: copyId, title: "Café menu (copy)" },
  })),
  getSessionTenancyCreateCapabilities: async () => ({ canCreatePrivate: true }),
};
const accessContext = {
  subjectId: "user:owner",
  workspaceGrants: [{ workspaceId, permissions: ["artifacts:read", "artifacts:publish"] }],
};

mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => ({
    accessContext,
    client: siteClient,
    workspaces: [{ id: workspaceId, name: "Kitchen", kind: "shared" }],
    managedSelfContext: null,
    startSession: async () => null,
    busy: false,
    authSession: { user: { name: "Dev" } },
  }),
}));

mock.module("@opengeni/react/sites", () => ({
  loadSiteSnapshot: async () => {
    if (loadError) throw loadError;
    return withoutContent ? { ...snapshot, content: null } : snapshot;
  },
}));

mock.module("@opengeni/react/app/lib/site-tool-bridge", () => ({
  createSiteToolBridge: () => undefined,
}));

mock.module("@opengeni/react/app/components/artifacts/site-conversations", () => ({
  SiteConversations: () => createElement("button", { type: "button" }, "Conversations"),
}));

const actualArtifacts = await import("@opengeni/react/artifacts");
mock.module("@opengeni/react/artifacts", () => ({
  ...actualArtifacts,
  ArtifactSandbox: ({
    children,
    fullScreen,
    onFullScreenChange,
  }: {
    children?: ReactNode;
    fullScreen?: boolean;
    onFullScreenChange?: (fullScreen: boolean) => void;
  }) =>
    createElement(
      "div",
      { "data-testid": "site-sandbox", "data-full-screen": String(fullScreen) },
      createElement(
        "button",
        { type: "button", onClick: () => onFullScreenChange?.(!fullScreen) },
        "Toggle full screen",
      ),
      children,
    ),
}));

mock.module("@opengeni/react/ui/confirm-dialog", () => ({
  ConfirmDialog: () => null,
  // The shared destructive confirmation imports this helper from the same module.
  destructiveActionFocusTarget: () => null,
}));

beforeAll(() => {
  GlobalRegistrator.register({ url: "https://example.test" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

async function renderDetail(initialEntry = "/?tab=versions") {
  const { ArtifactDetailRoute } = await import("@opengeni/react/app/routes/artifacts");
  const rootRoute = createRootRoute({ component: Outlet });
  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () =>
      createElement(ArtifactDetailRoute, {
        workspaceId,
        artifactId: siteId,
      }),
  });
  // Where the page sends people, for example the Site view.
  const elsewhere = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([detail, elsewhere]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    await router.load();
    root.render(createElement(RouterProvider, { router }));
  });
  return { container, root, router };
}

// Archive lives in the Site's Settings tab.
function hasArchive(container: HTMLElement) {
  return [...container.querySelectorAll('[role="tab"]')].some(
    (tab) => tab.textContent?.trim() === "Settings",
  );
}

function hasAction(container: HTMLElement, label: string) {
  const needle = label.replace(/\s+/g, " ").trim();
  return [...container.querySelectorAll("button, a")].some((node) => {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    return text === needle || text.includes(needle);
  });
}

test("loaded Site keeps Archive and Edit with Opengeni behind permission checks", async () => {
  loadError = null;
  const { container, root } = await renderDetail();
  try {
    expect(hasArchive(container)).toBe(true);
    expect(hasAction(container, "Edit with Opengeni")).toBe(true);
    expect(container.textContent).toContain("Café menu");
    // Its owner sees that it is Only me and can share it.
    expect(container.textContent).toContain("Only me");
    expect(hasAction(container, "Share with workspace")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

const sitePath = (id = siteId) => `/workspaces/${workspaceId}/sites/${id}`;

test("a link to the Site, or the Artifacts list's old one, opens the Site view in its place", async () => {
  loadError = null;
  for (const entry of ["/", "/?browse=true", "/?fromSession=s1"]) {
    const { container, root, router } = await renderDetail(entry);
    try {
      expect(router.state.location.pathname).toBe(sitePath());
      // Replaced, so Back leaves the Site instead of bouncing into it again.
      expect(router.history.length).toBe(1);
      expect(container.querySelector('[data-testid="site-sandbox"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }
});

test("the Site tab and Edit with Opengeni open the Site view; Edit starts a new conversation there", async () => {
  loadError = null;
  const tab = await renderDetail("/?tab=versions");
  try {
    const site = [...tab.container.querySelectorAll('[role="tab"]')].find(
      (element) => element.textContent?.trim() === "Site",
    ) as HTMLElement;
    await act(async () => {
      site.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      site.click();
    });
    expect(tab.router.state.location.pathname).toBe(sitePath());
    expect(tab.router.state.location.search).toEqual({});
  } finally {
    await act(async () => tab.root.unmount());
    tab.container.remove();
  }
  const edit = await renderDetail("/?tab=conversations");
  try {
    const button = [...edit.container.querySelectorAll("button")].find((element) =>
      element.textContent?.includes("Edit with Opengeni"),
    )!;
    await act(async () => button.click());
    expect(edit.router.state.location.pathname).toBe(sitePath());
    expect(edit.router.state.location.search).toEqual({ new: true });
  } finally {
    await act(async () => edit.root.unmount());
    edit.container.remove();
  }
});

test("an archived Site's details say so and offer no edit", async () => {
  loadError = null;
  snapshot.detail.artifact.status = "archived" as "active";
  const archived = await renderDetail();
  try {
    expect(archived.container.textContent).toContain("This Site is archived");
    expect(hasAction(archived.container, "Edit with Opengeni")).toBe(false);
  } finally {
    snapshot.detail.artifact.status = "active";
    await act(async () => archived.root.unmount());
    archived.container.remove();
  }
});

test("missing Site hides Archive and Edit with Opengeni", async () => {
  loadError = new OpenGeniApiError(404, "", { correlationId: "corr-missing-site" });
  const { container, root } = await renderDetail();
  try {
    expect(hasArchive(container)).toBe(false);
    expect(hasAction(container, "Edit with Opengeni")).toBe(false);
    expect(container.textContent).toContain("This Site isn't available");
    expect(container.textContent).toContain("Reference: corr-missing-site");
    expect(container.textContent).not.toContain("Opengeni API 404");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("read-only Site hides mutation actions but keeps its details", async () => {
  loadError = null;
  const permissions = accessContext.workspaceGrants[0]!.permissions;
  accessContext.workspaceGrants[0]!.permissions = [];
  const { container, root } = await renderDetail();
  try {
    expect(hasArchive(container)).toBe(false);
    expect(hasAction(container, "Edit with Opengeni")).toBe(false);
    expect(hasAction(container, "Share with workspace")).toBe(false);
    expect(container.textContent).toContain("Café menu");
  } finally {
    accessContext.workspaceGrants[0]!.permissions = permissions;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("malformed Site id hides mutation actions", async () => {
  loadError = new OpenGeniApiError(422, "", { correlationId: "corr-malformed-site" });
  const { container, root } = await renderDetail();
  try {
    expect(hasArchive(container)).toBe(false);
    expect(hasAction(container, "Edit with Opengeni")).toBe(false);
    expect(container.textContent).toContain("This Site link isn't valid");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("transient Site load failure offers retry without mutation actions", async () => {
  loadError = new OpenGeniApiError(503, "", { correlationId: "corr-transient-site" });
  const { container, root } = await renderDetail();
  try {
    expect(hasArchive(container)).toBe(false);
    expect(hasAction(container, "Edit with Opengeni")).toBe(false);
    expect(hasAction(container, "Retry")).toBe(true);
    expect(container.textContent).toContain("Couldn't load this Site");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Site read refusal explains missing artifact access instead of removal", async () => {
  const permissions = accessContext.workspaceGrants[0]!.permissions;
  for (const [error, grant] of [
    // The server refused the read.
    [new OpenGeniApiError(403, "", { correlationId: "corr-denied-site" }), permissions],
    // The viewer's own grant (for example the pre-0555 Member role) lacks artifacts:read.
    [new OpenGeniApiError(404, "", { correlationId: "corr-member-site" }), ["sessions:read"]],
  ] as const) {
    loadError = error;
    accessContext.workspaceGrants[0]!.permissions = [...grant];
    const { container, root } = await renderDetail();
    try {
      expect(container.textContent).toContain("You can't open this Site");
      expect(container.textContent).toContain(
        "You need access to artifacts in this workspace. Ask a workspace admin.",
      );
      expect(container.textContent).not.toContain("may have been removed");
      expect(hasAction(container, "Retry")).toBe(false);
      expect(hasArchive(container)).toBe(false);
    } finally {
      accessContext.workspaceGrants[0]!.permissions = permissions;
      await act(async () => root.unmount());
      container.remove();
    }
  }
});

test("Site without an openable version still shows its details instead of loading forever", async () => {
  loadError = null;
  withoutContent = true;
  const { container, root } = await renderDetail();
  try {
    expect(container.textContent).toContain("Café menu");
    expect(container.textContent).not.toContain("Loading Site");
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector('[data-testid="site-sandbox"]')).toBeNull();
  } finally {
    withoutContent = false;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Duplicate in Settings copies the Site and opens the copy in the Site view", async () => {
  loadError = null;
  withoutContent = false;
  siteClient.duplicateWorkspaceArtifact.mockClear();
  const { container, root, router } = await renderDetail("/?tab=settings");
  try {
    const duplicate = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Duplicate",
    );
    expect(duplicate).toBeDefined();
    await act(async () => duplicate!.click());
    expect(siteClient.duplicateWorkspaceArtifact).toHaveBeenCalledTimes(1);
    const [calledWorkspace, calledSite, request] = siteClient.duplicateWorkspaceArtifact.mock
      .calls[0] as [string, string, { idempotencyKey: string }];
    expect([calledWorkspace, calledSite]).toEqual([workspaceId, siteId]);
    expect(request.idempotencyKey).toBeString();
    expect(router.state.location.pathname).toBe(sitePath(copyId));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
