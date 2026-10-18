import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement, type ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "5d929faa-c755-4146-9d60-e55f42251f0d";
const siteId = "dc24100a-e408-4713-9c12-ef41e3964f6a";
const versionId = "11111111-1111-4111-8111-111111111111";

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
  getSessionTenancyCreateCapabilities: async () => ({ canCreatePrivate: true }),
};
const accessContext = {
  subjectId: "user:owner",
  workspaceGrants: [{ workspaceId, permissions: ["artifacts:read", "artifacts:publish"] }],
};

mock.module("@/context", () => ({
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

mock.module("@/lib/site-tool-bridge", () => ({
  createSiteToolBridge: () => undefined,
}));

mock.module("@/components/artifacts/site-conversations", () => ({
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

mock.module("@/components/ui/confirm-dialog", () => ({
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

async function renderDetail(initialEntry = "/") {
  const { ArtifactDetailRoute } = await import("./artifacts");
  const route = createRootRoute({
    component: () =>
      createElement(ArtifactDetailRoute, {
        workspaceId,
        artifactId: siteId,
      }),
  });
  const router = createRouter({
    routeTree: route,
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

/** Archive lives in the page's ⋯ menu. */
function hasArchive(container: HTMLElement) {
  return container.querySelector('button[aria-label^="More actions for"]') !== null;
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

test("a link opens the Site full screen; leaving it shows the Site's page", async () => {
  loadError = null;
  const { container, root, router } = await renderDetail("/");
  const sandbox = () => container.querySelector('[data-testid="site-sandbox"]')!;
  const toggle = () =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Toggle full screen",
    )!;
  try {
    expect(sandbox().getAttribute("data-full-screen")).toBe("true");
    await act(async () => toggle().click());
    expect(router.state.location.search).toEqual({ browse: true });
    expect(sandbox().getAttribute("data-full-screen")).toBe("false");
    // Expanding from the page replaces the same history entry.
    const entries = router.history.length;
    await act(async () => toggle().click());
    expect(router.state.location.search).toEqual({});
    expect(sandbox().getAttribute("data-full-screen")).toBe("true");
    expect(router.history.length).toBe(entries);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the Artifacts list and archived Sites open the Site's page", async () => {
  loadError = null;
  const listed = await renderDetail("/?browse=true");
  try {
    expect(
      listed.container
        .querySelector('[data-testid="site-sandbox"]')
        ?.getAttribute("data-full-screen"),
    ).toBe("false");
  } finally {
    await act(async () => listed.root.unmount());
    listed.container.remove();
  }
  snapshot.detail.artifact.status = "archived" as "active";
  const archived = await renderDetail("/");
  try {
    // Uncontrolled: the frame expands only when asked.
    expect(
      archived.container
        .querySelector('[data-testid="site-sandbox"]')
        ?.getAttribute("data-full-screen"),
    ).toBe("undefined");
    expect(archived.container.textContent).toContain("This Site is archived");
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

test("read-only Site hides mutation actions but keeps its preview", async () => {
  loadError = null;
  const permissions = accessContext.workspaceGrants[0]!.permissions;
  accessContext.workspaceGrants[0]!.permissions = [];
  const { container, root } = await renderDetail();
  try {
    expect(hasArchive(container)).toBe(false);
    expect(hasAction(container, "Edit with Opengeni")).toBe(false);
    expect(hasAction(container, "Share with workspace")).toBe(false);
    expect(container.querySelector('[data-testid="site-sandbox"]')).not.toBeNull();
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

test("Site without an openable version shows a final state instead of loading forever", async () => {
  loadError = null;
  withoutContent = true;
  const { container, root } = await renderDetail();
  try {
    expect(container.textContent).toContain("Café menu");
    expect(container.textContent).toContain("There's nothing to show for this Site");
    expect(container.textContent).not.toContain("Loading Site");
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector('[data-testid="site-sandbox"]')).toBeNull();
    expect(hasAction(container, "Retry")).toBe(true);
  } finally {
    withoutContent = false;
    await act(async () => root.unmount());
    container.remove();
  }
});
