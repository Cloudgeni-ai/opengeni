import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RetainedArtifactReference } from "@opengeni/sdk";
import { Markdown } from "@opengeni/react";
import { ArtifactLinkBoundary } from "../session/artifact-link-boundary";

GlobalRegistrator.register({ url: "https://console.example" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const id = "33333333-3333-4333-8333-333333333333";
const workspaceId = "11111111-1111-4111-8111-111111111111";
let artifact: RetainedArtifactReference;
let accessKeyVersion = 1;
const client = {
  getRetainedArtifact: mock(async () => artifact),
  createRetainedArtifactDownloadUrl: mock(async () => ({
    url: "https://media.example/video.mp4",
    expiresAt: "2099-01-01T00:00:00Z",
  })),
  createVideoArtifactPlaybackSource: mock(async () => ({
    url: "https://media.example/generated.mp4",
  })),
  downloadRetainedArtifact: mock(async () => ({
    bytes: new Uint8Array([37, 80, 68, 70]),
    artifact,
  })),
};
mock.module("@/context", () => ({ useAppContext: () => ({ client, accessKeyVersion }) }));
mock.module("./pdf-file-preview", () => ({
  default: ({ title }: { title: string }) => {
    if (title === "Broken PDF") throw new Error("PDF renderer failed");
    return <span>{title} rendered PDF</span>;
  },
}));
const { InlineChatArtifact, RetainedFilePreview } = await import("./retained-file-preview");
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  artifact = {
    available: true,
    artifactId: id,
    kind: "file",
    contentType: "video/mp4",
    originalBytes: 4,
    sha256: "a".repeat(64),
    retainedAt: "2026-09-01T00:00:00Z",
    retention: { policy: "workspace_file", expiresAt: null },
    retrieval: {
      method: "GET",
      path: `/v1/workspaces/${workspaceId}/artifacts/${id}/content`,
      acceptRanges: "bytes",
      maxRangeBytes: 1048576,
    },
  };
  accessKeyVersion = 1;
  for (const fn of Object.values(client)) fn.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

test("equivalent receipts preserve playback while authorization changes refresh the source", async () => {
  await act(async () =>
    root.render(
      <RetainedFilePreview workspaceId={workspaceId} artifact={artifact} title="Video" />,
    ),
  );
  const video = container.querySelector("video");
  await act(async () =>
    root.render(
      <RetainedFilePreview workspaceId={workspaceId} artifact={{ ...artifact }} title="Renamed" />,
    ),
  );
  expect(container.querySelector("video")).toBe(video);
  expect(client.createRetainedArtifactDownloadUrl).toHaveBeenCalledTimes(1);
  accessKeyVersion++;
  await act(async () =>
    root.render(
      <RetainedFilePreview workspaceId={workspaceId} artifact={{ ...artifact }} title="Video" />,
    ),
  );
  expect(client.createRetainedArtifactDownloadUrl).toHaveBeenCalledTimes(2);
  expect(container.querySelector("video")).not.toBe(video);
  artifact = { ...artifact, sha256: "b".repeat(64) };
  await act(async () =>
    root.render(
      <RetainedFilePreview workspaceId={workspaceId} artifact={artifact} title="Video" />,
    ),
  );
  expect(client.createRetainedArtifactDownloadUrl).toHaveBeenCalledTimes(3);
  await act(async () =>
    root.render(
      <RetainedFilePreview
        workspaceId={workspaceId}
        artifact={{ ...artifact, available: false }}
        title="Video"
      />,
    ),
  );
  expect(container.querySelector("video")).toBeNull();
  expect(container.textContent).toContain("Artifact unavailable");
  expect(client.createRetainedArtifactDownloadUrl).toHaveBeenCalledTimes(3);
});

test("PDF renderer failures stay inside the preview", async () => {
  artifact = { ...artifact, contentType: "application/pdf" };
  await act(async () =>
    root.render(
      <div>
        <span>Conversation remains</span>
        <RetainedFilePreview workspaceId={workspaceId} artifact={artifact} title="Broken PDF" />
      </div>,
    ),
  );
  expect(container.textContent).toContain("Conversation remains");
  expect(container.textContent).toContain("PDF preview unavailable");
});

test("published link opens sidebar and embed renders playable video with stable chat space", async () => {
  const open = mock(() => true);
  await act(async () =>
    root.render(
      <ArtifactLinkBoundary workspaceId={workspaceId} onOpen={open}>
        <Markdown
          artifactHref={(value) => `/workspaces/${workspaceId}/artifacts/files/${value}`}
          renderImage={() => (
            <InlineChatArtifact workspaceId={workspaceId} artifactId={id} alt="Review cut" />
          )}
        >{`[Watch](artifact:${id})\n\n![Review cut](artifact:${id})`}</Markdown>
      </ArtifactLinkBoundary>,
    ),
  );
  await act(async () => container.querySelector("button")?.click());
  await act(async () =>
    container
      .querySelector("a")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
  );
  expect(open).toHaveBeenCalledWith({ id, editable: false, kind: "file" });
  expect(container.querySelector("video")?.getAttribute("src")).toBe(
    "https://media.example/video.mp4",
  );
  expect(container.querySelector("video")?.hasAttribute("controls")).toBe(true);
  expect(container.querySelector("video")?.hasAttribute("autoplay")).toBe(false);
  expect(container.querySelector(".h-\\[400px\\]")).not.toBeNull();
  expect(client.downloadRetainedArtifact).not.toHaveBeenCalled();
});

test("audio and generated video use authorized sources; unknown formats never fetch bytes", async () => {
  artifact = { ...artifact, contentType: "audio/mpeg" };
  await act(async () =>
    root.render(
      <RetainedFilePreview workspaceId={workspaceId} artifact={artifact} title="Audio" />,
    ),
  );
  expect(container.querySelector("audio")).not.toBeNull();
  artifact = { ...artifact, kind: "generated_video", contentType: "video/mp4" };
  await act(async () =>
    root.render(
      <RetainedFilePreview workspaceId={workspaceId} artifact={artifact} title="Video" />,
    ),
  );
  expect(client.createVideoArtifactPlaybackSource).toHaveBeenCalled();
  artifact = { ...artifact, kind: "file", contentType: "text/html" };
  await act(async () =>
    root.render(<RetainedFilePreview workspaceId={workspaceId} artifact={artifact} title="HTML" />),
  );
  expect(container.querySelector("iframe,object,video,audio")).toBeNull();
  expect(container.textContent).toContain("Download it");
});

test("media failure offers retry and refreshes authorization", async () => {
  await act(async () =>
    root.render(
      <RetainedFilePreview workspaceId={workspaceId} artifact={artifact} title="Video" />,
    ),
  );
  await act(async () => container.querySelector("video")!.dispatchEvent(new Event("error")));
  expect(container.textContent).toContain("Retry preview");
  await act(async () => container.querySelector("button")!.click());
  expect(client.createRetainedArtifactDownloadUrl).toHaveBeenCalledTimes(2);
  accessKeyVersion++;
  await act(async () =>
    root.render(
      <RetainedFilePreview workspaceId={workspaceId} artifact={artifact} title="Video" />,
    ),
  );
  expect(client.createRetainedArtifactDownloadUrl).toHaveBeenCalledTimes(3);
});

test("PDF bytes use a typed disposable Blob and revoke it when the preview closes", async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const create = mock((_blob: Blob) => "blob:test-pdf");
  const revoke = mock((_url: string) => {});
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
  try {
    artifact = { ...artifact, contentType: "application/pdf" };
    await act(async () =>
      root.render(
        <RetainedFilePreview workspaceId={workspaceId} artifact={artifact} title="Report" />,
      ),
    );
    expect(client.downloadRetainedArtifact).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].type).toBe("application/pdf");
    await act(async () => root.render(null));
    expect(revoke).toHaveBeenCalledWith("blob:test-pdf");
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("unavailable artifact retains an actionable link without requesting media", async () => {
  client.getRetainedArtifact.mockRejectedValueOnce(new Error("Access denied"));
  await act(async () =>
    root.render(
      <InlineChatArtifact workspaceId={workspaceId} artifactId={id} alt="Missing file" />,
    ),
  );
  await act(async () => container.querySelector("button")?.click());
  expect(container.textContent).toContain("Artifact unavailable");
  expect(container.querySelector("a")?.getAttribute("href")).toContain(`/artifacts/files/${id}`);
  expect(client.createRetainedArtifactDownloadUrl).not.toHaveBeenCalled();
});
