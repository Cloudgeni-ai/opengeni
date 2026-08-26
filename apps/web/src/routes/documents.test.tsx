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
const listAccessibleDocuments = mock(async (_workspaceId: string) => [
  indexedDocument("workspace"),
]);
const uploadFile = mock(async (_workspaceId: string, _request: unknown) => ({
  id: "44444444-4444-4444-8444-444444444444",
}));
const createKnowledgeDrop = mock(
  async (_workspaceId: string, request: { authorityKind?: DocumentAuthorityKind }) =>
    indexedDocument(request.authorityKind ?? "workspace"),
);
const searchKnowledge = mock(async () => ({ results: [] }));
const createDocumentOriginalFileDownloadUrl = mock(async () => ({
  url: "https://storage.example.test/document",
  expiresAt: "2026-08-15T12:00:00.000Z",
}));
const context = {
  client: {
    listDocumentBases,
    listAccessibleDocuments,
    uploadFile,
    createKnowledgeDrop,
    searchKnowledge,
    createDocumentOriginalFileDownloadUrl,
  },
  clientConfig: { fileUploads: { enabled: true, maxSizeBytes: 10_000_000 } },
  workspaces: [{ id: "workspace-a", accountId: "account-a", kind: "shared", settings: {} }],
  managedSelfContext: null,
};

mock.module("@/context", () => ({
  useAppContext: () => context,
}));

const {
  DEFAULT_DOCUMENT_AUTHORITY_KIND,
  DOCUMENT_AUTHORITY_OPTIONS,
  DocumentsRoute,
  defaultDocumentAuthorityKind,
  documentAuthorityLabel,
  documentTypeLabel,
  localPopulatedDocumentsPreview,
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
  listAccessibleDocuments.mockClear();
  uploadFile.mockClear();
  createKnowledgeDrop.mockClear();
  searchKnowledge.mockClear();
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

function setControlledInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  expect(reactPropsKey).toBeDefined();
  const onChange = (
    input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>
  )[reactPropsKey!]!.onChange;
  expect(typeof onChange).toBe("function");
  onChange!({ target: input });
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

describe("Documents scope-first UX", () => {
  test("provides a development-only populated preview across file types and scopes", () => {
    expect(
      localPopulatedDocumentsPreview("?previewDocuments=populated", "workspace-a", false),
    ).toBeNull();
    const preview = localPopulatedDocumentsPreview(
      "?previewDocuments=populated",
      "workspace-a",
      true,
    );
    expect(preview?.documents.map((document) => document.authorityKind)).toEqual([
      "organization",
      "workspace",
      "organization",
      "workspace",
      "personal",
    ]);
    expect(preview?.documents.map(documentTypeLabel)).toEqual([
      "PDF",
      "Word document",
      "Image",
      "Spreadsheet",
      "Text",
    ]);
  });

  test("uses the fixed authority labels, mappings, and workspace-safe default", () => {
    expect(DOCUMENT_AUTHORITY_OPTIONS).toEqual([
      { value: "organization", label: "Company" },
      { value: "workspace", label: "Current workspace" },
      { value: "personal", label: "Only me" },
    ]);
    expect(DEFAULT_DOCUMENT_AUTHORITY_KIND).toBe("workspace");
    expect(defaultDocumentAuthorityKind(false)).toBe("workspace");
    expect(defaultDocumentAuthorityKind(true)).toBe("personal");
    expect(documentAuthorityLabel("organization")).toBe("Company");
    expect(documentAuthorityLabel("workspace")).toBe("Current workspace");
    expect(documentAuthorityLabel("personal")).toBe("Only me");
  });

  test("defaults new knowledge to Only me in a personal workspace", async () => {
    context.workspaces[0]!.kind = "personal";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<DocumentsRoute workspaceId="workspace-a" />);
        await Promise.resolve();
      });
      await settleRoute();

      expect(
        container.querySelector<HTMLSelectElement>('[aria-label="Drop authority"]')?.value,
      ).toBe("personal");
      expect(container.textContent).toContain("Your personal document library");
      expect(container.textContent).toContain("Knowledge available to you");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      context.workspaces[0]!.kind = "shared";
    }
  });

  test("opens the organization explorer filtered to Company and defaults new knowledge there", async () => {
    listAccessibleDocuments.mockResolvedValueOnce([
      { ...indexedDocument("workspace"), id: crypto.randomUUID(), title: "Workspace runbook" },
      { ...indexedDocument("organization"), id: crypto.randomUUID(), title: "Company strategy" },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<DocumentsRoute workspaceId="workspace-a" authorityKind="organization" />);
        await Promise.resolve();
      });
      await settleRoute();

      expect(container.textContent).toContain("Company knowledge");
      expect(container.textContent).toContain("Organization knowledge");
      expect(container.textContent).toContain("Company strategy");
      expect(container.textContent).not.toContain("Workspace runbook");
      expect(
        container.querySelector<HTMLSelectElement>('[aria-label="Drop authority"]')?.value,
      ).toBe("organization");

      const query = container.querySelector<HTMLInputElement>(
        '[aria-label="Search indexed documents"]',
      )!;
      await act(async () => setControlledInput(query, "company strategy"));
      const search = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Search",
      )!;
      await act(async () => {
        search.click();
        await Promise.resolve();
      });
      await settleRoute();
      expect(searchKnowledge).toHaveBeenCalledWith("workspace-a", {
        query: "company strategy",
        limit: 50,
        mode: "hybrid",
      });

      const dropText = container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Knowledge drop text"]',
      )!;
      await act(async () => setControlledTextarea(dropText, "Organization fact"));
      const add = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Add",
      )!;
      await act(async () => {
        add.click();
        await Promise.resolve();
      });
      await settleRoute();

      expect(createKnowledgeDrop).toHaveBeenCalledWith(
        "workspace-a",
        expect.objectContaining({ text: "Organization fact", authorityKind: "organization" }),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("shows one upload surface and keeps internal collections out of the UI", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<DocumentsRoute workspaceId="workspace-a" />);
        await Promise.resolve();
      });
      await settleRoute();

      expect(listAccessibleDocuments).toHaveBeenCalledWith("workspace-a");
      expect(container.textContent).toContain(
        "Add information agents can find when it is relevant",
      );
      expect(container.textContent).toContain("Add knowledge");
      expect(container.textContent).not.toContain("Collections");
      expect(container.textContent).not.toContain("Create collection");
      expect(container.textContent).not.toContain("Add files to collection");
      expect(container.textContent).not.toContain("Advanced access");
      expect(container.textContent).not.toContain("ACL tags");
      expect(container.textContent).not.toContain("Search filters");
      expect(container.textContent).not.toContain("Create your first base");
      const upload = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Choose files",
      );
      expect(upload).not.toBeUndefined();
      expect(upload?.disabled).toBe(false);
      const authoritySelect = container.querySelector<HTMLSelectElement>(
        '[aria-label="Drop authority"]',
      );
      expect(authoritySelect?.value).toBe("workspace");
      expect(
        [...authoritySelect!.options].map((option) => [option.value, option.textContent]),
      ).toEqual([
        ["organization", "Company"],
        ["workspace", "Current workspace"],
        ["personal", "Only me"],
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("propagates the selected authority through text and file ingestion", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<DocumentsRoute workspaceId="workspace-a" />);
        await Promise.resolve();
      });
      await settleRoute();

      const dropAuthority = container.querySelector<HTMLSelectElement>(
        '[aria-label="Drop authority"]',
      )!;
      await act(async () => {
        dropAuthority.value = "organization";
        dropAuthority.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const fileUpload = container.querySelector<HTMLInputElement>(
        '[aria-label="Add files as a knowledge drop"]',
      )!;
      const upload = new File(["company"], "company.txt", { type: "text/plain" });
      Object.defineProperty(fileUpload, "files", { configurable: true, value: [upload] });
      await act(async () => {
        fileUpload.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
      });
      await settleRoute();

      expect(createKnowledgeDrop).toHaveBeenCalledWith(
        "workspace-a",
        expect.objectContaining({
          fileId: "44444444-4444-4444-8444-444444444444",
          authorityKind: "organization",
          agentAccess: true,
        }),
      );

      const dropText = container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Knowledge drop text"]',
      )!;
      await act(async () => {
        dropAuthority.value = "personal";
        dropAuthority.dispatchEvent(new Event("change", { bubbles: true }));
        setControlledTextarea(dropText, "Personal note");
      });
      const dropButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Add",
      )!;
      await act(async () => {
        dropButton.click();
        await Promise.resolve();
      });
      await settleRoute();

      expect(createKnowledgeDrop).toHaveBeenCalledWith(
        "workspace-a",
        expect.objectContaining({
          text: "Personal note",
          authorityKind: "personal",
          agentAccess: true,
        }),
      );

      const droppedFile = new File(["personal file"], "personal.txt", { type: "text/plain" });
      await act(async () => {
        fireFileDrop(container.querySelector<HTMLElement>('[aria-label="Knowledge drop zone"]')!, [
          droppedFile,
        ]);
        await Promise.resolve();
      });
      await settleRoute();

      expect(createKnowledgeDrop.mock.calls).toContainEqual([
        "workspace-a",
        expect.objectContaining({
          fileId: "44444444-4444-4444-8444-444444444444",
          authorityKind: "personal",
          agentAccess: true,
        }),
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("searches all effective knowledge without a collection filter", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<DocumentsRoute workspaceId="workspace-a" />);
        await Promise.resolve();
      });
      await settleRoute();

      const query = container.querySelector<HTMLInputElement>(
        '[aria-label="Search indexed documents"]',
      )!;
      await act(async () => setControlledInput(query, "company policy"));
      const search = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Search",
      )!;
      await act(async () => {
        search.click();
        await Promise.resolve();
      });
      await settleRoute();

      expect(searchKnowledge).toHaveBeenCalledWith("workspace-a", {
        query: "company policy",
        limit: 8,
        mode: "hybrid",
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
