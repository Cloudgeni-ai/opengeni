/* ----------------------------------------------------------------------------
   ChatComposer's opt-in `imageTags`: each image the person adds puts a plain
   `[Image N]` tag in the text where they were writing, its chip shows the
   same number, removing an image removes its tag and renumbers the rest, and
   images restored with a draft keep the tags their text already has.
   -------------------------------------------------------------------------- */
import { afterEach, describe, expect, test } from "bun:test";
import type { ResourceRef } from "@opengeni/sdk";
import { act, useImperativeHandle, useState, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer } from "../src/components/chat-composer";
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

type Sent = { text: string; images: string[] };

type HarnessHandle = {
  /** Bring a draft back, as a queued-prompt recall or a reload does. */
  restoreDraft: (text: string, resources: ResourceRef[]) => void;
  /** Bring files back as attachments, as the new-chat draft does. */
  restoreAttachments: (text: string, files: FileAttachment[]) => void;
  /** A steered message was accepted: clear the text and remove its images together. */
  acceptSteer: (sentNames: string[]) => void;
  sent: Sent[];
};

type HarnessProps = {
  imageTags?: boolean;
  working?: boolean;
  loadFileContentType?: UseFileAttachmentsResult["loadFileContentType"];
};

function Harness({
  handleRef,
  imageTags = true,
  working = false,
  loadFileContentType,
}: HarnessProps & { handleRef: Ref<HarnessHandle> }) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [restored, setRestored] = useState<ResourceRef[]>([]);
  const [sent] = useState<Sent[]>([]);
  useImperativeHandle(handleRef, () => ({
    restoreDraft: (text, resources) => {
      setValue(text);
      setRestored(resources);
    },
    restoreAttachments: (text, restoredFiles) => {
      setValue(text);
      setFiles(restoredFiles);
    },
    acceptSteer: (sentNames) => {
      setValue("");
      setFiles((current) => current.filter((file) => !sentNames.includes(file.name)));
    },
    sent,
  }));
  const addFiles = (incoming: Iterable<File>) => {
    const added = [...incoming].map(
      (file): FileAttachment => ({
        id: `attachment:${file.name}`,
        name: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        status: "ready",
      }),
    );
    setFiles((current) => [...current, ...added]);
  };
  const attachments: UseFileAttachmentsResult = {
    attachments: files,
    readyResources: [],
    uploading: false,
    hasUnresolved: false,
    addFiles,
    addFromPaste: (event) =>
      addFiles(
        [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/")),
      ),
    restoreReadyFiles: () => {},
    retry: () => {},
    retainPreview: () => undefined,
    remove: (id) => setFiles((current) => current.filter((file) => file.id !== id)),
    removeReadyFiles: () => {},
    clear: () => setFiles([]),
    ...(loadFileContentType ? { loadFileContentType } : {}),
  };
  const record = (): true => {
    sent.push({
      text: value,
      images: [
        ...restored.flatMap((resource) => (resource.kind === "file" ? [resource.fileId] : [])),
        ...files.map((file) => file.name),
      ],
    });
    return true;
  };
  const composer: ComposerState = {
    value,
    setValue,
    hasDraftContent: () => value.length > 0 || files.length > 0,
    send: async () => {
      record();
      // Send clears the text first; the host then removes the files it sent.
      setValue("");
      setRestored([]);
      setFiles([]);
      return true;
    },
    steer: async () => record(),
    sending: false,
    canSend: true,
    working,
    ...(working
      ? {
          busySend: "queue" as const,
          alternateSend: "steer" as const,
          sendAlternate: async () => record(),
        }
      : {}),
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
    restoredResources: restored,
    removeRestoredResource: (index) =>
      setRestored((current) => current.filter((_, position) => position !== index)),
    error: null,
    clearError: () => {},
  };
  return (
    <ChatComposer
      composer={composer}
      attachments={attachments}
      runControl="none"
      {...(imageTags ? { imageTags: true } : {})}
    />
  );
}

async function mount(props: HarnessProps = {}) {
  const handle: { current: HarnessHandle | null } = { current: null };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(<Harness handleRef={handle} {...props} />);
  });
  return { container, handle: () => handle.current!, field: () => textarea(container) };
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

/** Type `value` into the composer and leave the caret at `caret`. */
async function type(container: HTMLElement, value: string, caret = value.length) {
  const field = textarea(container);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, value);
    // happy-dom does not drive React's change tracking; call the handler directly.
    const propsKey = Object.keys(field).find((key) => key.startsWith("__reactProps$"))!;
    const props = (field as unknown as Record<string, { onChange: (event: unknown) => void }>)[
      propsKey
    ]!;
    props.onChange({ target: field, currentTarget: field });
  });
  field.focus();
  field.setSelectionRange(caret, caret);
}

async function paste(container: HTMLElement, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: fileList(files) } });
  await act(async () => {
    textarea(container).dispatchEvent(event);
  });
  await settle();
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

async function attach(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

function chipLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-image-tag]")].map(
    (label) => label.textContent ?? "",
  );
}

async function clickLabelled(container: HTMLElement, label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  await settle();
}

describe("ChatComposer image tags", () => {
  test("off by default: adding an image leaves the text alone and the chip unnumbered", async () => {
    const view = await mount({ imageTags: false });
    await type(view.container, "Look at this");
    await paste(view.container, [image("one.png")]);
    expect(view.field().value).toBe("Look at this");
    expect(chipLabels(view.container)).toEqual([]);
  });

  test("pasting several images at once tags them in order at the caret", async () => {
    const view = await mount();
    await type(view.container, "Look at this and that", 12);
    await paste(view.container, [image("one.png"), image("two.png")]);
    expect(view.field().value).toBe("Look at this [Image 1] [Image 2] and that");
    expect(chipLabels(view.container)).toEqual(["Image 1", "Image 2"]);
  });

  test("drag and drop and the attach button tag images where the person was writing", async () => {
    const view = await mount();
    await type(view.container, "The header ");
    await drop(view.container, [image("header.png")]);
    expect(view.field().value).toBe("The header [Image 1] ");
    await type(view.container, "The header [Image 1] and the footer ");
    await attach(view.container, [
      image("footer.png"),
      new File(["%PDF"], "spec.pdf", { type: "application/pdf" }),
    ]);
    // Only images are tagged; a document attached with them is not.
    expect(view.field().value).toBe("The header [Image 1] and the footer [Image 2] ");
    expect(chipLabels(view.container)).toEqual(["Image 1", "Image 2"]);
  });

  test("removing an image removes its tag and renumbers the rest, wherever they were moved", async () => {
    const view = await mount();
    await paste(view.container, [image("a.png"), image("b.png"), image("c.png")]);
    expect(view.field().value).toBe("[Image 1] [Image 2] [Image 3] ");
    // The person writes around the tags and moves the third one first.
    await type(view.container, "[Image 3] is the fix; [Image 1] was before and [Image 2] after");
    await clickLabelled(view.container, "Remove a.png");
    expect(view.field().value).toBe("[Image 2] is the fix; was before and [Image 1] after");
    expect(chipLabels(view.container)).toEqual(["Image 1", "Image 2"]);
    // A tag the person deleted by hand just stays gone.
    await type(view.container, "only the fix now");
    await clickLabelled(view.container, "Remove b.png");
    expect(view.field().value).toBe("only the fix now");
    expect(chipLabels(view.container)).toEqual(["Image 1"]);
  });

  test("after Send the next message starts again at Image 1", async () => {
    const view = await mount();
    await type(view.container, "first ");
    await paste(view.container, [image("one.png")]);
    await act(async () => {
      textarea(view.container).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(view.handle().sent).toEqual([{ text: "first [Image 1] ", images: ["one.png"] }]);
    expect(view.field().value).toBe("");
    await paste(view.container, [image("two.png")]);
    expect(view.field().value).toBe("[Image 1] ");
  });

  test("Steer sends the tags as written; an image added while it lands is renumbered", async () => {
    const view = await mount({ working: true });
    await type(view.container, "use this ");
    await paste(view.container, [image("steer.png")]);
    const steer = view.container.querySelector<HTMLButtonElement>(
      "[data-og-composer-alternate-send]",
    )!;
    expect(steer.textContent).toBe("Steer");
    await act(async () => steer.click());
    await settle();
    expect(view.handle().sent).toEqual([{ text: "use this [Image 1] ", images: ["steer.png"] }]);
    // The person keeps writing while the steer is delivered.
    await type(view.container, "use this [Image 1] next ");
    await paste(view.container, [image("later.png")]);
    expect(view.field().value).toBe("use this [Image 1] next [Image 2] ");
    await act(async () => view.handle().acceptSteer(["steer.png"]));
    await settle();
    expect(view.field().value).toBe("");
    expect(chipLabels(view.container)).toEqual(["Image 1"]);
    await paste(view.container, [image("third.png")]);
    expect(view.field().value).toBe("[Image 2] ");
  });

  test("a restored draft keeps its tags, and new images are numbered after its images", async () => {
    const view = await mount({
      loadFileContentType: async (fileId) =>
        fileId === "file-doc" ? "application/pdf" : "image/png",
    });
    await act(async () =>
      view.handle().restoreDraft("Before [Image 1], after [Image 2]. ", [
        { kind: "file", fileId: "file-before" },
        { kind: "file", fileId: "file-doc" },
        { kind: "file", fileId: "file-after" },
      ]),
    );
    await settle();
    expect(view.field().value).toBe("Before [Image 1], after [Image 2]. ");
    expect(chipLabels(view.container)).toEqual(["Image 1", "Image 2"]);
    await type(view.container, "Before [Image 1], after [Image 2]. And now ");
    await paste(view.container, [image("now.png")]);
    expect(view.field().value).toBe("Before [Image 1], after [Image 2]. And now [Image 3] ");
    expect(chipLabels(view.container)).toEqual(["Image 1", "Image 2", "Image 3"]);
    // Removing a restored image works like removing an attachment.
    await clickLabelled(view.container, "Remove restored resource 1");
    expect(view.field().value).toBe("Before, after [Image 1]. And now [Image 2] ");
    expect(chipLabels(view.container)).toEqual(["Image 1", "Image 2"]);
  });

  test("attachments restored with a new-chat draft are not tagged again", async () => {
    const view = await mount();
    const restored = (name: string): FileAttachment => ({
      id: `restored:${name}`,
      name,
      contentType: "image/png",
      sizeBytes: 6,
      status: "ready",
      restored: true,
    });
    await act(async () =>
      view
        .handle()
        .restoreAttachments("one [Image 1] two [Image 2]", [restored("a.png"), restored("b.png")]),
    );
    await settle();
    expect(view.field().value).toBe("one [Image 1] two [Image 2]");
    expect(chipLabels(view.container)).toEqual(["Image 1", "Image 2"]);
    await clickLabelled(view.container, "Remove a.png");
    expect(view.field().value).toBe("one two [Image 1]");
  });
});
