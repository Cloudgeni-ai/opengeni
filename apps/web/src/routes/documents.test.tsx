import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { DocumentBase } from "@/types";

const defaultBase: DocumentBase = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "workspace-a",
  name: "Default",
  description: "Default base for dropped files and notes.",
  createdAt: "2026-08-02T12:00:00.000Z",
  updatedAt: "2026-08-02T12:00:00.000Z",
};
const customBase: DocumentBase = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: "workspace-a",
  name: "Runbooks",
  description: null,
  createdAt: "2026-08-02T12:01:00.000Z",
  updatedAt: "2026-08-02T12:01:00.000Z",
};
const listDocuments = mock(async (_workspaceId: string, _baseId: string) => []);
const context = {
  client: {
    listDocumentBases: mock(async () => [customBase, defaultBase]),
    listDocuments,
  },
  clientConfig: { fileUploads: { enabled: true, maxSizeBytes: 10_000_000 } },
};

mock.module("@/context", () => ({
  useAppContext: () => context,
}));

const { DocumentsRoute, resolveDocumentCollectionSelection } = await import("./documents");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("Documents Default collection UX", () => {
  test("keeps valid choices and recovers missing choices to Default", () => {
    expect(resolveDocumentCollectionSelection(customBase.id, [customBase, defaultBase])).toBe(
      customBase.id,
    );
    expect(resolveDocumentCollectionSelection(null, [customBase, defaultBase])).toBe(
      defaultBase.id,
    );
    expect(
      resolveDocumentCollectionSelection("deleted-collection", [customBase, defaultBase]),
    ).toBe(defaultBase.id);
  });

  test("renders upload as the primary empty-state action without a create-base gate", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<DocumentsRoute workspaceId="workspace-a" />);
        await Promise.resolve();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(listDocuments).toHaveBeenCalledWith("workspace-a", defaultBase.id);
      expect(container.textContent).toContain("Upload immediately for agent search");
      expect(container.textContent).toContain("Collections (optional)");
      expect(container.textContent).toContain("New collectionoptional");
      expect(container.textContent).not.toContain("Create your first base");
      const upload = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Upload files",
      );
      expect(upload).not.toBeUndefined();
      expect(upload?.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
