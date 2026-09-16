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

const snapshot = {
  detail: {
    artifact: {
      id: siteId,
      workspaceId,
      title: "Café menu",
      description: "An interactive workspace Site.",
      status: "active" as const,
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
};
const accessContext = {
  workspaceGrants: [{ workspaceId, permissions: ["artifacts:publish"] }],
};

mock.module("@/context", () => ({
  useAppContext: () => ({
    accessContext,
    client: siteClient,
    startSession: async () => null,
    busy: false,
    authSession: { user: { name: "Dev" } },
  }),
}));

mock.module("@opengeni/react/sites", () => ({
  loadSiteSnapshot: async () => {
    if (loadError) throw loadError;
    return snapshot;
  },
}));

mock.module("@/lib/site-tool-bridge", () => ({
  createSiteToolBridge: () => undefined,
}));

mock.module("@/components/artifacts/site-conversations", () => ({
  SiteConversations: () => createElement("button", { type: "button" }, "Conversations"),
}));

mock.module("@/components/artifacts/artifact-sandbox", () => ({
  ArtifactSandbox: ({ children }: { children?: ReactNode }) =>
    createElement("div", { "data-testid": "site-sandbox" }, children),
}));

mock.module("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: () => null,
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

async function renderDetail() {
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
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    await router.load();
    root.render(createElement(RouterProvider, { router }));
  });
  return { container, root };
}

function hasAction(container: HTMLElement, label: string) {
  const needle = label.replace(/\s+/g, " ").trim();
  return [...container.querySelectorAll("button, a")].some((node) => {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    return text === needle || text.includes(needle);
  });
}

test("loaded Site keeps Archive and Edit with Geni behind permission checks", async () => {
  loadError = null;
  const { container, root } = await renderDetail();
  try {
    expect(hasAction(container, "Archive")).toBe(true);
    expect(hasAction(container, "Edit with Geni")).toBe(true);
    expect(container.textContent).toContain("Café menu");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("missing Site hides Archive and Edit with Geni", async () => {
  loadError = new OpenGeniApiError(404, "", { correlationId: "corr-missing-site" });
  const { container, root } = await renderDetail();
  try {
    expect(hasAction(container, "Archive")).toBe(false);
    expect(hasAction(container, "Edit with Geni")).toBe(false);
    expect(container.textContent).toContain("This Site isn't available");
    expect(container.textContent).toContain("Reference: corr-missing-site");
    expect(container.textContent).not.toContain("OpenGeni API 404");
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
    expect(hasAction(container, "Archive")).toBe(false);
    expect(hasAction(container, "Edit with Geni")).toBe(false);
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
    expect(hasAction(container, "Archive")).toBe(false);
    expect(hasAction(container, "Edit with Geni")).toBe(false);
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
    expect(hasAction(container, "Archive")).toBe(false);
    expect(hasAction(container, "Edit with Geni")).toBe(false);
    expect(hasAction(container, "Retry")).toBe(true);
    expect(container.textContent).toContain("Couldn't load this Site");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
