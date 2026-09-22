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

const context = {
  accessKeyVersion: 0,
  client: {
    createVideoArtifactPlaybackSource: playback,
    downloadRetainedArtifact: genericDownload,
    getRetainedArtifact: async () => {
      if (loadError) throw loadError;
      return {
        available: true,
        artifactId,
        kind: artifactKind,
        contentType: artifactKind === "generated_video" ? "video/mp4" : "image/png",
      };
    },
    getFile: async () => null,
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

async function renderRoute() {
  const { RetainedArtifactRoute } = await import("./retained-artifact");
  const route = createRootRoute({
    component: () => <RetainedArtifactRoute workspaceId={workspaceId} artifactId={artifactId} />,
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
    root.render(<RouterProvider router={router} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("malformed retained-file ids show unavailable copy and All artifacts", async () => {
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
    expect(rendered.container.textContent).toContain("All artifacts");
    expect(rendered.container.textContent).toContain("Support reference");
    expect(rendered.container.textContent).toContain("corr-malformed");
    expect(rendered.container.textContent).not.toContain("OpenGeni API");
    expect(rendered.container.textContent).not.toContain("Retry");
    const link = rendered.container.querySelector("a");
    expect(link?.textContent).toContain("All artifacts");
    expect(link?.getAttribute("href")).toBe(`/workspaces/${workspaceId}/artifacts`);
  } finally {
    await rendered.unmount();
  }
});

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
  const rendered = await renderRoute();
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
    expect(missing.container.textContent).not.toContain("OpenGeni API");
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
    expect(forbidden.container.textContent).not.toContain("OpenGeni API");
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
    expect(rendered.container.textContent).toContain("All artifacts");
    expect(rendered.container.textContent).toContain("Retry");
    expect(rendered.container.textContent).toContain("corr-503");
    expect(rendered.container.textContent).not.toContain("OpenGeni API");
  } finally {
    await rendered.unmount();
  }
});
