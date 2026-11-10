/* ----------------------------------------------------------------------------
   The Opengeni app's composer: an image added by drag and drop, paste or the
   file picker shows as a compact attachment chip with its file name, like any
   other file. Nothing is written into the message text.
   -------------------------------------------------------------------------- */
import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppContext, type AppContextValue } from "../src/app/app-context";
import { ConsoleComposer } from "../src/app/components/Composer";
import type { ComposerState } from "../src/hooks/use-composer";
import type { FileAttachment, UseFileAttachmentsResult } from "../src/hooks/use-file-attachments";
import { registerDom } from "./render-hook";

registerDom();

let mounted: { root: Root; container: HTMLElement } | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await act(async () => current.root.unmount());
    current.container.remove();
  }
});

const appContext = {
  client: {},
  clientConfig: {},
  workspaces: [],
  managedSelfContext: null,
} as unknown as AppContextValue;

function Harness() {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const addFiles = (incoming: Iterable<File>) =>
    setFiles((current) => [
      ...current,
      ...[...incoming].map(
        (file): FileAttachment => ({
          id: `attachment:${file.name}`,
          name: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          status: "ready",
        }),
      ),
    ]);
  const attachments: UseFileAttachmentsResult = {
    attachments: files,
    readyResources: [],
    uploading: false,
    hasUnresolved: false,
    addFiles,
    addFromPaste: (event) => addFiles([...(event.clipboardData?.files ?? [])]),
    restoreReadyFiles: () => {},
    retry: () => {},
    retainPreview: () => undefined,
    remove: (id) => setFiles((current) => current.filter((file) => file.id !== id)),
    removeReadyFiles: () => {},
    clear: () => setFiles([]),
  };
  const composer: ComposerState = {
    value,
    setValue,
    hasDraftContent: () => value.length > 0 || files.length > 0,
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: true,
    working: false,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    applyDraft: () => {},
    reloadDraft: async () => {},
    resolveDraftConflict: async () => {},
    restoredResources: [],
    removeRestoredResource: () => {},
    error: null,
    clearError: () => {},
  };
  return (
    <AppContext.Provider value={appContext}>
      <ConsoleComposer
        workspaceId="workspace-1"
        composer={composer}
        attachments={attachments}
        fileUploadsEnabled
      />
    </AppContext.Provider>
  );
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(<Harness />);
  });
  return container;
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector("textarea")!;
}

function image(name: string): File {
  return new File(["pixels"], name, { type: "image/png" });
}

function fileList(files: File[]): FileList {
  return {
    ...files,
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: () => files[Symbol.iterator](),
  } as unknown as FileList;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function drop(container: HTMLElement, files: File[]) {
  const event = new DragEvent("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files: fileList(files) },
  });
  await act(async () => {
    textarea(container).parentElement!.dispatchEvent(event);
  });
  await settle();
}

async function paste(container: HTMLElement, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: fileList(files) } });
  await act(async () => {
    textarea(container).dispatchEvent(event);
  });
  await settle();
}

async function attach(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

function expectPlainChips(container: HTMLElement, names: string[]) {
  expect(textarea(container).value).toBe("");
  expect(container.querySelectorAll("[data-image-tag]")).toHaveLength(0);
  const text = container.textContent ?? "";
  for (const name of names) expect(text).toContain(name);
}

describe("Opengeni app composer images", () => {
  test("a dropped image is a file chip, with nothing added to the text", async () => {
    const container = await mount();
    await drop(container, [image("screenshot.png")]);
    expectPlainChips(container, ["screenshot.png"]);
  });

  test("paste and the file picker behave the same as drop", async () => {
    const container = await mount();
    await paste(container, [image("pasted.png")]);
    await attach(container, [image("picked.png")]);
    expectPlainChips(container, ["pasted.png", "picked.png"]);
  });
});
