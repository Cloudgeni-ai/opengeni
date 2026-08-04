import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { DocumentAuthorityKind, DocumentBase } from "@/types";

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
const uploadFile = mock(async () => ({ id: "33333333-3333-4333-8333-333333333333" }));
const addDocument = mock(async () => ({
  id: "44444444-4444-4444-8444-444444444444",
  baseId: defaultBase.id,
}));
const createKnowledgeDrop = mock(async () => ({
  id: "55555555-5555-4555-8555-555555555555",
  baseId: defaultBase.id,
  curationStatus: "none" as const,
}));
const context = {
  client: {
    listDocumentBases: mock(async () => [customBase, defaultBase]),
    listDocuments,
    uploadFile,
    addDocument,
    createKnowledgeDrop,
  },
  clientConfig: { fileUploads: { enabled: true, maxSizeBytes: 10_000_000 } },
};

mock.module("@/context", () => ({
  useAppContext: () => context,
}));

const {
  DocumentsRoute,
  documentAuthorityOptions,
  documentAuthorityRequest,
  resolveDocumentCollectionSelection,
} = await import("./documents");

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

beforeEach(() => {
  listDocuments.mockClear();
  uploadFile.mockClear();
  addDocument.mockClear();
  createKnowledgeDrop.mockClear();
});

describe("Documents Default collection UX", () => {
  test("maps Company, Current workspace, and Only me to fixed authority kinds", () => {
    expect(documentAuthorityOptions).toEqual([
      { value: "organization", label: "Company" },
      { value: "workspace", label: "Current workspace" },
      { value: "personal", label: "Only me" },
    ]);
    for (const authorityKind of [
      "organization",
      "workspace",
      "personal",
    ] satisfies DocumentAuthorityKind[]) {
      expect(documentAuthorityRequest(authorityKind)).toEqual({ authorityKind });
    }
  });

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
      expect(container.textContent).toContain("Company");
      expect(container.textContent).toContain("Current workspace");
      expect(container.textContent).toContain("Only me");
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

  test("sends the selected authority for direct knowledge drops", async () => {
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

      const authority = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Drop document authority"]',
      );
      const text = container.querySelector<HTMLTextAreaElement>("textarea");
      const drop = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Drop",
      );
      expect(authority).not.toBeNull();
      expect(text).not.toBeNull();
      expect(drop).not.toBeUndefined();

      await act(async () => {
        if (!authority || !text || !drop) return;
        authority.value = "organization";
        authority.dispatchEvent(new Event("change", { bubbles: true }));
        text.value = "Company handbook";
        text.dispatchEvent(new Event("input", { bubbles: true }));
        drop.click();
        await Promise.resolve();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(createKnowledgeDrop).toHaveBeenCalledWith("workspace-a", {
        text: "Company handbook",
        authorityKind: "organization",
        agentAccess: true,
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
