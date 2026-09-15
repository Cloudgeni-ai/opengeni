import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { KnowledgeOriginalFileDownload } from "@opengeni/sdk";
const file = {
  filename: "screenshot.png",
  contentType: "image/png",
  url: "https://files.example/image.png",
  expiresAt: "2099-01-01T00:00:00Z",
} as KnowledgeOriginalFileDownload;
const download = mock(async (): Promise<KnowledgeOriginalFileDownload> => file);
const context = {
  client: { createKnowledgeFileDownloadUrl: download },
  accessContext: {},
  workspaceStateOwnerId: "owner",
};
mock.module("@/context", () => ({ useAppContext: () => context }));
const { KnowledgeOriginalFile } = await import("./knowledge-original-file");
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

test("selected source previews its image with extracted text collapsed; manual evidence stays lazy", async () => {
  download.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <KnowledgeOriginalFile workspaceId="workspace" entryId="source" revisionId="revision" />,
    ),
  );
  expect(download).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <KnowledgeOriginalFile
        workspaceId="workspace"
        entryId="selected"
        revisionId="revision"
        autoOpen
        extractedText={"exact OCR\ntext"}
      />,
    ),
  );
  expect(download).toHaveBeenCalledWith("workspace", "selected", "revision");
  expect(container.querySelector("img")?.getAttribute("src")).toBe(file.url);
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector("details")?.textContent).toContain("exact OCR\ntext");
  await act(async () => root.unmount());
});

test("original URL and delayed response cannot survive a changed access identity", async () => {
  let settle!: (file: KnowledgeOriginalFileDownload) => void;
  download.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  const element = () => (
    <KnowledgeOriginalFile
      workspaceId="workspace"
      entryId="source"
      revisionId="revision"
      autoOpen
    />
  );
  await act(async () => root.render(element()));
  context.accessContext = {};
  download.mockRejectedValueOnce(new Error("Original is no longer accessible"));
  await act(async () => root.render(element()));
  await act(async () => settle(file));
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("Original is no longer accessible");
  expect(container.innerHTML).not.toContain(file.url);
  await act(async () => root.unmount());
});

test("failed preview leaves extracted text available and retry reauthorizes the selected revision", async () => {
  download.mockRejectedValueOnce(new Error("Storage unavailable"));
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <KnowledgeOriginalFile
        workspaceId="workspace"
        entryId="retry"
        revisionId="revision"
        autoOpen
        extractedText="Retained exact text"
      />,
    ),
  );
  expect(container.textContent).toContain("Storage unavailable");
  expect(container.querySelector("details")?.textContent).toContain("Retained exact text");
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("img")?.getAttribute("src")).toBe(file.url);
  await act(async () => root.unmount());
});
