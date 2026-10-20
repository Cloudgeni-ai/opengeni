import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError } from "@opengeni/sdk";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const missingUuid = "22222222-2222-4222-8222-222222222222";
let artifactId = "does-not-exist";
let artifactKind = "generated_image";
const playback = mock(async () => ({ url: "https://media.example/video.mp4" }));
const genericDownload = mock(async () => {
  throw new Error("Wrong download API");
});
let loadError: Error | null = new OpenGeniApiError(
  404,
  JSON.stringify({ error: { message: "artifact not found" } }),
  { correlationId: "corr-test-404" },
);

let fileAsset: Record<string, unknown> | null = null;
const updateFileVisibility = mock(
  async (_workspaceId: string, _fileId: string, request: { visibility: string }) => ({
    file: { ...fileAsset, scope: request.visibility === "private" ? "personal" : "workspace" },
  }),
);

const context = {
  accessKeyVersion: 0,
  workspaces: [{ id: workspaceId, accountId: "acct-1", kind: "shared", name: "Design" }],
  managedSelfContext: null,
  accessContext: {
    subjectId: "user-owner",
    workspaceGrants: [{ workspaceId, permissions: ["files:read", "files:upload"] }],
  },
  client: {
    updateFileVisibility,
    getSessionTenancyCreateCapabilities: async () => ({ canCreatePrivate: true }),
    createVideoArtifactPlaybackSource: playback,
    createRetainedArtifactDownloadUrl: async () => ({
      url: "https://media.example/image.png",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
    downloadRetainedArtifact: genericDownload,
    getRetainedArtifact: async () => {
      if (loadError) throw loadError;
      return {
        available: true,
        artifactId,
        kind: artifactKind,
        contentType: artifactKind === "generated_video" ? "video/mp4" : "image/png",
        originalBytes: 4,
        sha256: "a".repeat(64),
        retainedAt: "2026-09-01T00:00:00Z",
        dimensions: { width: 1, height: 1 },
        retention: { policy: "workspace_file", expiresAt: null },
        retrieval: {
          method: "GET",
          path: `/v1/workspaces/${workspaceId}/artifacts/${artifactId}/content`,
          acceptRanges: "bytes",
          maxRangeBytes: 1048576,
        },
      };
    },
    getFile: async () => fileAsset,
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

async function renderRoute(embedded = false, initialEntry = "/") {
  const { RetainedArtifactRoute } = await import("./retained-artifact");
  const route = createRootRoute({
    component: () => (
      <RetainedArtifactRoute
        workspaceId={workspaceId}
        artifactId={artifactId}
        embedded={embedded}
      />
    ),
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
    root.render(<RouterProvider router={router} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    router,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("malformed retained-file ids show unavailable copy and the Artifacts back link", async () => {
  artifactId = "does-not-exist";
  loadError = new OpenGeniApiError(
    404,
    JSON.stringify({ error: { message: "artifact not found" } }),
    { correlationId: "corr-malformed" },
  );
  const rendered = await renderRoute();
  try {
    expect(rendered.container.textContent).toContain("Artifact unavailable");
    expect(rendered.container.textContent).toContain("This file isn't available.");
    expect(rendered.container.textContent).toContain("Artifacts");
    expect(rendered.container.textContent).toContain("Support reference");
    expect(rendered.container.textContent).toContain("corr-malformed");
    expect(rendered.container.textContent).not.toContain("Opengeni API");
    expect(rendered.container.textContent).not.toContain("Retry");
    const link = rendered.container.querySelector("a");
    expect(link?.textContent?.trim()).toBe("Artifacts");
    expect(link?.getAttribute("href")).toBe(`/workspaces/${workspaceId}/artifacts`);
  } finally {
    await rendered.unmount();
  }
});

for (const state of ["loading", "loaded", "error"] as const) {
  test(`embedded retained artifact omits the Artifacts back link while ${state}`, async () => {
    artifactId = missingUuid;
    loadError = state === "error" ? new Error("Unavailable") : null;
    const originalLoad = context.client.getRetainedArtifact;
    if (state === "loading") {
      context.client.getRetainedArtifact = () => new Promise(() => {});
    }
    const rendered = await renderRoute(true);
    try {
      expect(rendered.container.textContent).not.toContain("Artifacts");
      expect(rendered.container.textContent).toContain(
        state === "loading"
          ? "Loading artifact"
          : state === "error"
            ? "Artifact unavailable"
            : "Download",
      );
      if (state === "loaded") {
        expect(rendered.container.querySelector("[data-chat-media]")).toBeNull();
        expect(rendered.container.querySelector("img")?.getAttribute("src")).toBe(
          "https://media.example/image.png",
        );
      }
    } finally {
      await rendered.unmount();
      context.client.getRetainedArtifact = originalLoad;
    }
  });
}

test("generated video opens the browser player without generic byte download", async () => {
  artifactId = missingUuid;
  artifactKind = "generated_video";
  loadError = null;
  playback.mockClear();
  genericDownload.mockClear();
  const originalClick = HTMLAnchorElement.prototype.click;
  const opened: string[] = [];
  HTMLAnchorElement.prototype.click = function () {
    opened.push(this.href);
  };
  const rendered = await renderRoute(false, "/?browse=true");
  try {
    const button = [...rendered.container.querySelectorAll("button")].find(
      (item) => item.textContent === "Open video",
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(opened).toEqual(["https://media.example/video.mp4"]);
    expect(genericDownload).not.toHaveBeenCalled();
  } finally {
    await rendered.unmount();
    HTMLAnchorElement.prototype.click = originalClick;
    artifactKind = "generated_image";
  }
});

test("a link opens a previewable file full screen; Back shows its page", async () => {
  artifactId = missingUuid;
  artifactKind = "generated_image";
  loadError = null;
  const rendered = await renderRoute();
  const fullView = () => document.body.querySelector("[data-artifact-fullscreen]");
  const button = (root: ParentNode, label: string) =>
    [...root.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  try {
    expect(fullView()).not.toBeNull();
    expect(fullView()!.querySelector("img")?.getAttribute("src")).toBe(
      "https://media.example/image.png",
    );
    expect(button(fullView()!, "Download")).toBeDefined();
    await act(async () => button(fullView()!, "Back")!.click());
    expect(fullView()).toBeNull();
    expect(rendered.router.state.location.search).toEqual({ browse: true });
    expect(rendered.container.textContent).toContain("Artifacts");
    await act(async () => button(rendered.container, "Full screen")!.click());
    expect(fullView()).not.toBeNull();
    expect(rendered.router.state.location.search).toEqual({});
  } finally {
    await rendered.unmount();
  }
});

test("valid missing retained-file UUIDs match 403 copy and omit retry", async () => {
  artifactId = missingUuid;
  loadError = new OpenGeniApiError(
    404,
    JSON.stringify({ error: { message: "artifact not found" } }),
    { correlationId: "corr-missing-uuid" },
  );
  const missing = await renderRoute();
  try {
    expect(missing.container.textContent).toContain("Artifact unavailable");
    expect(missing.container.textContent).not.toContain("Opengeni API");
    expect(missing.container.textContent).not.toContain("Retry");
  } finally {
    await missing.unmount();
  }

  loadError = new OpenGeniApiError(403, JSON.stringify({ error: { message: "forbidden" } }), {
    correlationId: "corr-forbidden",
  });
  const forbidden = await renderRoute();
  try {
    expect(forbidden.container.textContent).toContain("Artifact unavailable");
    expect(forbidden.container.textContent).toContain("This file isn't available.");
    expect(forbidden.container.textContent).not.toContain("Opengeni API");
    expect(forbidden.container.textContent).not.toContain("Retry");
  } finally {
    await forbidden.unmount();
  }
});

test("transient retained-file failures keep retry without raw API prefix", async () => {
  artifactId = missingUuid;
  loadError = new OpenGeniApiError(503, JSON.stringify({ error: { message: "unavailable" } }), {
    retryable: true,
    correlationId: "corr-503",
  });
  const rendered = await renderRoute();
  try {
    expect(rendered.container.textContent).toContain("Couldn't load this file");
    expect(rendered.container.textContent).toContain("Artifacts");
    expect(rendered.container.textContent).toContain("Retry");
    expect(rendered.container.textContent).toContain("corr-503");
    expect(rendered.container.textContent).not.toContain("Opengeni API");
  } finally {
    await rendered.unmount();
  }
});

test("someone else's private file explains it is private without naming it", async () => {
  artifactId = missingUuid;
  loadError = new OpenGeniApiError(
    403,
    JSON.stringify({ artifactId: missingUuid, available: false, reason: "private" }),
    { correlationId: "corr-private" },
  );
  const rendered = await renderRoute();
  try {
    expect(rendered.container.textContent).toContain("This file is private");
    expect(rendered.container.textContent).toContain("Ask them to share it with the workspace.");
    expect(rendered.container.textContent).not.toContain("Artifact unavailable");
    expect(rendered.container.textContent).not.toContain("Retry");
    expect(rendered.container.textContent).toContain("Artifacts");
  } finally {
    await rendered.unmount();
    loadError = null;
  }
});

test("a file's owner sees Only me and can share it with the workspace", async () => {
  artifactId = missingUuid;
  artifactKind = "file";
  loadError = null;
  fileAsset = {
    id: missingUuid,
    workspaceId,
    filename: "report.pdf",
    scope: "personal",
    ownerSubjectId: "user-owner",
  };
  updateFileVisibility.mockClear();
  const rendered = await renderRoute(false, "/?browse=true");
  const button = (label: string) =>
    [...document.body.querySelectorAll("button")].find((item) =>
      item.textContent?.trim().endsWith(label),
    );
  try {
    expect(rendered.container.textContent).toContain("report.pdf");
    expect(rendered.container.textContent).toContain("Only me");
    await act(async () => button("Share with workspace")!.click());
    expect(document.body.textContent).toContain("Share “report.pdf” with Design?");
    const confirm = [
      ...document.body.querySelectorAll<HTMLButtonElement>(
        "[role=alertdialog] button, [role=dialog] button",
      ),
    ].find((item) => item.textContent?.trim() === "Share with workspace");
    await act(async () => {
      confirm!.click();
      await Promise.resolve();
    });
    expect(updateFileVisibility).toHaveBeenCalledWith(workspaceId, missingUuid, {
      visibility: "workspace",
    });
    expect(rendered.container.textContent).toContain("Workspace");
  } finally {
    await rendered.unmount();
    fileAsset = null;
    artifactKind = "generated_image";
  }
});

test("someone else's shared file shows Workspace without a share control", async () => {
  artifactId = missingUuid;
  artifactKind = "file";
  loadError = null;
  fileAsset = {
    id: missingUuid,
    workspaceId,
    filename: "notes.txt",
    scope: "workspace",
    ownerSubjectId: "someone-else",
  };
  const rendered = await renderRoute(false, "/?browse=true");
  try {
    expect(rendered.container.textContent).toContain("Workspace");
    expect(rendered.container.textContent).not.toContain("Share with workspace");
    expect(
      rendered.container.querySelector(
        "[aria-label^='Who can open this file: Workspace. Everyone in Design']",
      ),
    ).not.toBeNull();
  } finally {
    await rendered.unmount();
    fileAsset = null;
    artifactKind = "generated_image";
  }
});
