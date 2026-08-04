import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { DocumentAuthorityKind, DocumentBase, IndexedDocument } from "@/types";

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

function indexedDocument(authorityKind: DocumentAuthorityKind): IndexedDocument {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId: "workspace-a",
    baseId: defaultBase.id,
    fileId: "44444444-4444-4444-8444-444444444444",
    status: "ready",
    title: "Uploaded document",
    parser: "text",
    chunkCount: 1,
    error: null,
    sourceKind: "manual_upload",
    sourceUri: null,
    sourceExternalId: null,
    sourceTitle: null,
    sourceAuthor: null,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    sourceVersion: null,
    aclTags: [],
    authorityKind,
    authorityWorkspaceId: authorityKind === "organization" ? null : "workspace-a",
    authoritySubjectId: authorityKind === "personal" ? "subject-a" : null,
    visibility: authorityKind === "personal" ? "private" : "workspace",
    createdBy: "subject-a",
    agentAccess: true,
    summary: null,
    topics: [],
    curationStatus: "none",
    curation: null,
    createdAt: "2026-08-04T01:00:00.000Z",
    updatedAt: "2026-08-04T01:00:00.000Z",
  };
}

const listDocumentBases = mock(async () => [customBase, defaultBase]);
const listDocuments = mock(async (_workspaceId: string, _baseId: string) => []);
const uploadFile = mock(async (_workspaceId: string, _request: unknown) => ({
  id: "44444444-4444-4444-8444-444444444444",
}));
const addDocument = mock(
  async (
    _workspaceId: string,
    _baseId: string,
    request: { authorityKind?: DocumentAuthorityKind },
  ) => indexedDocument(request.authorityKind ?? "workspace"),
);
const createKnowledgeDrop = mock(
  async (_workspaceId: string, request: { authorityKind?: DocumentAuthorityKind }) =>
    indexedDocument(request.authorityKind ?? "workspace"),
);
const context = {
  client: {
    listDocumentBases,
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
  DEFAULT_DOCUMENT_AUTHORITY_KIND,
  DOCUMENT_AUTHORITY_OPTIONS,
  DocumentsRoute,
  documentAuthorityLabel,
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
  listDocumentBases.mockClear();
  listDocuments.mockClear();
  uploadFile.mockClear();
  addDocument.mockClear();
  createKnowledgeDrop.mockClear();
});

async function settleRoute(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setControlledTextarea(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
    textarea,
    value,
  );
  const reactPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"));
  expect(reactPropsKey).toBeDefined();
  const onChange = (
    textarea as unknown as Record<
      string,
      { onChange?: (event: { target: HTMLTextAreaElement }) => void }
    >
  )[reactPropsKey!]!.onChange;
  expect(typeof onChange).toBe("function");
  onChange!({ target: textarea });
}

function fireFileDrop(target: HTMLElement, files: File[]): void {
  const fileList = {
    ...files,
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: () => files[Symbol.iterator](),
  } as unknown as FileList;
  const event = new DragEvent("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    configurable: true,
    value: { files: fileList } as DataTransfer,
  });
  target.dispatchEvent(event);
}

describe("Documents Default collection UX", () => {
  test("uses the fixed authority labels, mappings, and workspace-safe default", () => {
    expect(DOCUMENT_AUTHORITY_OPTIONS).toEqual([
      { value: "organization", label: "Company" },
      { value: "workspace", label: "Current workspace" },
      { value: "personal", label: "Only me" },
    ]);
    expect(DEFAULT_DOCUMENT_AUTHORITY_KIND).toBe("workspace");
    expect(documentAuthorityLabel("organization")).toBe("Company");
    expect(documentAuthorityLabel("workspace")).toBe("Current workspace");
    expect(documentAuthorityLabel("personal")).toBe("Only me");
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
      await settleRoute();

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
      const authoritySelects = [
        container.querySelector<HTMLSelectElement>('[aria-label="Drop authority"]'),
        container.querySelector<HTMLSelectElement>('[aria-label="Upload authority"]'),
      ];
      for (const select of authoritySelects) {
        expect(select?.value).toBe("workspace");
        expect([...select!.options].map((option) => [option.value, option.textContent])).toEqual([
          ["organization", "Company"],
          ["workspace", "Current workspace"],
          ["personal", "Only me"],
        ]);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("propagates the selected authority through uploads and text/file drops", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<DocumentsRoute workspaceId="workspace-a" />);
        await Promise.resolve();
      });
      await settleRoute();

      const uploadAuthority = container.querySelector<HTMLSelectElement>(
        '[aria-label="Upload authority"]',
      )!;
      await act(async () => {
        uploadAuthority.value = "organization";
        uploadAuthority.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const ordinaryUpload = container.querySelector<HTMLInputElement>(
        '[aria-label="Upload documents to selected collection"]',
      )!;
      const upload = new File(["company"], "company.txt", { type: "text/plain" });
      Object.defineProperty(ordinaryUpload, "files", { configurable: true, value: [upload] });
      await act(async () => {
        ordinaryUpload.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
      });
      await settleRoute();

      expect(addDocument).toHaveBeenCalledWith(
        "workspace-a",
        defaultBase.id,
        expect.objectContaining({
          fileId: "44444444-4444-4444-8444-444444444444",
          authorityKind: "organization",
        }),
      );

      const dropAuthority = container.querySelector<HTMLSelectElement>(
        '[aria-label="Drop authority"]',
      )!;
      const dropText = container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Knowledge drop text"]',
      )!;
      await act(async () => {
        dropAuthority.value = "personal";
        dropAuthority.dispatchEvent(new Event("change", { bubbles: true }));
        setControlledTextarea(dropText, "Personal note");
      });
      const dropButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Drop",
      )!;
      await act(async () => {
        dropButton.click();
        await Promise.resolve();
      });
      await settleRoute();

      expect(createKnowledgeDrop).toHaveBeenCalledWith(
        "workspace-a",
        expect.objectContaining({ text: "Personal note", authorityKind: "personal" }),
      );

      const droppedFile = new File(["personal file"], "personal.txt", { type: "text/plain" });
      await act(async () => {
        fireFileDrop(
          container.querySelector<HTMLElement>('[aria-label="Knowledge drop zone"]')!,
          [droppedFile],
        );
        await Promise.resolve();
      });
      await settleRoute();

      expect(createKnowledgeDrop.mock.calls).toContainEqual([
        "workspace-a",
        expect.objectContaining({
          fileId: "44444444-4444-4444-8444-444444444444",
          authorityKind: "personal",
        }),
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
