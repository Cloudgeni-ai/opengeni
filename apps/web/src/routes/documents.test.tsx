import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import type { FileAsset, FileListRequest, FileListResponse } from "@opengeni/sdk";
const original: FileAsset = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "workspace-a",
  scope: "workspace",
  status: "ready",
  filename: "Acme-contract.pdf",
  safeFilename: "Acme-contract.pdf",
  contentType: "application/pdf",
  sizeBytes: 1024,
  sha256: null,
  bucket: "local",
  objectKey: "contract",
  createdAt: "2026-09-10T00:00:00Z",
  updatedAt: "2026-09-10T00:00:00Z",
};
const listFiles = mock(
  async (_workspace: string, _options: FileListRequest): Promise<FileListResponse> => ({
    files: [original],
    nextCursor: null,
  }),
);
const uploadFile = mock(async (_workspace: string, _input: unknown) => original);
const createKnowledgeDrop = mock(async (_workspace: string, _request: unknown) => ({
  status: "pending",
  error: null,
}));
const context = {
  client: { listFiles, uploadFile, createKnowledgeDrop },
  clientConfig: { fileUploads: { enabled: true } },
  accessContext: {
    mode: "local",
    subjectId: "dev",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: "workspace-a",
        permissions: ["files:read", "files:upload", "documents:manage"],
      },
    ],
  },
  workspaces: [{ id: "workspace-a", accountId: "account-a", kind: "shared", settings: {} }],
  managedSelfContext: null,
};
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("@/components/knowledge/knowledge-browser", () => ({
  KnowledgeBrowser: () => <div>Canonical source browser</div>,
}));
const { DocumentsRoute } = await import("./documents");
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  listFiles.mockReset();
  listFiles.mockResolvedValue({ files: [original], nextCursor: null });
  uploadFile.mockClear();
  createKnowledgeDrop.mockClear();
});
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <DocumentsRoute workspaceId="workspace-a" /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  return {
    container,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
async function scope(container: HTMLElement, value: string) {
  const select = container.querySelector<HTMLSelectElement>(
    '[aria-label="File and source scope"]',
  )!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
test("lists retained chat originals and links each to its canonical Knowledge", async () => {
  const view = await mount();
  try {
    expect(listFiles).toHaveBeenCalledWith("workspace-a", { scope: "workspace", limit: 30 });
    expect(view.container.textContent).toContain("Acme-contract.pdf");
    expect(view.container.textContent).toContain("Original copy");
    const link = [...view.container.querySelectorAll("a")].find(
      (a) => a.textContent === "Related knowledge",
    )!;
    expect(link.getAttribute("href")).toContain(`file=${original.id}`);
    expect(view.container.textContent).not.toContain("No documents yet");
  } finally {
    await view.close();
  }
});
test("changing ownership scope ignores a late result for the previous scope", async () => {
  let finish!: (value: FileListResponse) => void;
  listFiles.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = await mount();
  try {
    listFiles.mockResolvedValueOnce({
      files: [{ ...original, id: "private", scope: "personal", filename: "Private.pdf" }],
      nextCursor: null,
    });
    await scope(view.container, "personal");
    await act(async () => finish({ files: [original], nextCursor: null }));
    expect(view.container.textContent).toContain("Private.pdf");
    expect(view.container.textContent).not.toContain("Acme-contract.pdf");
  } finally {
    await view.close();
  }
});
test("a personal upload marks the original private before requesting source preparation", async () => {
  const view = await mount();
  try {
    await scope(view.container, "personal");
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = new DataTransfer();
    files.items.add(new File(["pdf"], "Private.pdf", { type: "application/pdf" }));
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: files.files });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(uploadFile).toHaveBeenCalledWith(
      "workspace-a",
      expect.objectContaining({ scope: "personal", filename: "Private.pdf" }),
    );
    expect(createKnowledgeDrop).toHaveBeenCalledWith("workspace-a", {
      fileId: original.id,
      authorityKind: "personal",
      agentAccess: true,
    });
  } finally {
    await view.close();
  }
});
