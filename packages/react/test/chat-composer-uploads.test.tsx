/* ----------------------------------------------------------------------------
   ChatComposer's opt-in `attachments` prop: the built-in attach button, the
   attachment-chips strip, the paste->addFromPaste wiring, and the send-gate
   that blocks BOTH the button and Enter while files are uploading.
   -------------------------------------------------------------------------- */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
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
    await act(async () => {
      current.root.unmount();
    });
    current.container.remove();
  }
});

function makeComposer(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    value: "hello there",
    setValue: () => {},
    send: async () => true,
    sending: false,
    canSend: true,
    mode: "queue",
    setMode: () => {},
    interrupt: async () => {},
    interrupting: false,
    error: null,
    clearError: () => {},
    ...overrides,
  };
}

function makeAttachments(overrides: Partial<UseFileAttachmentsResult> = {}): UseFileAttachmentsResult {
  return {
    attachments: [],
    readyResources: [],
    uploading: false,
    addFiles: () => {},
    addFromPaste: () => {},
    retry: () => {},
    remove: () => {},
    clear: () => {},
    ...overrides,
  };
}

function readyChip(name: string): FileAttachment {
  return { id: crypto.randomUUID(), name, contentType: "image/png", sizeBytes: 2048, status: "ready" };
}

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted = { root, container };
  return container;
}

function sendButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === "Send message",
  ) as HTMLButtonElement | undefined;
}

/**
 * Dispatch a synthetic drag/drop event on `target`. Browsers report dragged
 * files via `dataTransfer.types` including the literal "Files"; we mirror that
 * (happy-dom's DragEvent leaves `dataTransfer` undefined, so we attach our own).
 */
function fireDrag(
  target: HTMLElement,
  type: "dragover" | "dragleave" | "drop",
  options: { files?: File[]; types?: string[] } = {},
): DragEvent {
  const files = options.files ?? [];
  const types = options.types ?? (files.length > 0 ? ["Files"] : []);
  const fileList = {
    ...files,
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: () => files[Symbol.iterator](),
  } as unknown as FileList;
  const dataTransfer = { types, files: fileList } as unknown as DataTransfer;
  const event = new DragEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer, configurable: true });
  target.dispatchEvent(event);
  return event;
}

function fieldWrapper(container: HTMLElement): HTMLElement {
  // The field-chrome div (direct parent of the textarea) owns the drop handlers.
  return container.querySelector("textarea")!.parentElement as HTMLElement;
}

describe("ChatComposer attachments", () => {
  test("with no attachments prop, no attach button renders (backward compatible)", async () => {
    const container = await mount(<ChatComposer composer={makeComposer()} />);
    const attach = [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Attach files");
    expect(attach).toBeUndefined();
  });

  test("the attach button and hidden file input render in controlsStart when attachments is present", async () => {
    const container = await mount(<ChatComposer composer={makeComposer()} attachments={makeAttachments()} />);
    const attach = [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Attach files");
    expect(attach).toBeTruthy();
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    expect(input?.getAttribute("multiple")).not.toBeNull();
  });

  test("attachment chips render above the textarea when files are attached", async () => {
    const attachments = makeAttachments({ attachments: [readyChip("screenshot.png")] });
    const container = await mount(<ChatComposer composer={makeComposer()} attachments={attachments} />);
    expect(container.textContent ?? "").toContain("screenshot.png");
    // The remove control for the chip is present.
    const remove = [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Remove screenshot.png");
    expect(remove).toBeTruthy();
  });

  test("while uploading, the send button is disabled and Enter does not call send", async () => {
    let sent = 0;
    const composer = makeComposer({ send: async () => { sent += 1; return true; } });
    const attachments = makeAttachments({ uploading: true, attachments: [{ ...readyChip("a.png"), status: "uploading" }] });
    const container = await mount(<ChatComposer composer={composer} attachments={attachments} />);

    expect(sendButton(container)!.disabled).toBe(true);

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(sent).toBe(0);
    await act(async () => {
      sendButton(container)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(sent).toBe(0);
  });

  test("with uploads settled, Enter sends and the button is enabled", async () => {
    let sent = 0;
    const composer = makeComposer({ send: async () => { sent += 1; return true; } });
    const attachments = makeAttachments({ uploading: false, attachments: [readyChip("a.png")], readyResources: [{ kind: "file", fileId: "f1" }] });
    const container = await mount(<ChatComposer composer={composer} attachments={attachments} />);

    expect(sendButton(container)!.disabled).toBe(false);
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(sent).toBe(1);
  });

  test("send is ENABLED with a ready attachment even when the draft is empty (file-only message)", async () => {
    // A composer over an empty draft reports canSend=false; the ready attachment
    // is what makes the message sendable, and ChatComposer ORs it in.
    const composer = makeComposer({ value: "", canSend: false });
    const attachments = makeAttachments({ attachments: [readyChip("a.png")], readyResources: [{ kind: "file", fileId: "f1" }] });
    const container = await mount(<ChatComposer composer={composer} attachments={attachments} />);
    expect(sendButton(container)!.disabled).toBe(false);
  });

  test("send stays DISABLED with an empty draft and no attachment", async () => {
    const composer = makeComposer({ value: "", canSend: false });
    const attachments = makeAttachments(); // no ready resources
    const container = await mount(<ChatComposer composer={composer} attachments={attachments} />);
    expect(sendButton(container)!.disabled).toBe(true);
  });

  test("send stays BLOCKED while an attachment is still uploading, even with a ready one alongside", async () => {
    const composer = makeComposer({ value: "", canSend: false });
    const attachments = makeAttachments({
      uploading: true,
      attachments: [readyChip("ready.png"), { ...readyChip("pending.png"), status: "uploading" }],
      readyResources: [{ kind: "file", fileId: "f1" }],
    });
    const container = await mount(<ChatComposer composer={composer} attachments={attachments} />);
    expect(sendButton(container)!.disabled).toBe(true);
  });

  test("pasting into the textarea routes the clipboard through addFromPaste (and still calls host onPaste)", async () => {
    let pastedThroughHook = 0;
    let hostPaste = 0;
    const attachments = makeAttachments({ addFromPaste: () => { pastedThroughHook += 1; } });
    const container = await mount(
      <ChatComposer composer={makeComposer()} attachments={attachments} onPaste={() => { hostPaste += 1; }} />,
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      textarea.focus();
      // happy-dom's ClipboardEvent carries a clipboardData the React handler reads.
      textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(pastedThroughHook).toBe(1);
    expect(hostPaste).toBe(1);
  });

  test("dropping files onto the composer routes them through addFiles (the all-files picker path)", async () => {
    const added: File[][] = [];
    const attachments = makeAttachments({ addFiles: (files) => { added.push([...files]); } });
    const container = await mount(<ChatComposer composer={makeComposer()} attachments={attachments} />);
    const field = fieldWrapper(container);
    const pdf = new File(["%PDF"], "doc.pdf", { type: "application/pdf" });
    await act(async () => {
      // A dragover sets the dragging state; the drop enqueues the files.
      fireDrag(field, "dragover", { files: [pdf] });
      fireDrag(field, "drop", { files: [pdf] });
      await Promise.resolve();
    });
    expect(added).toHaveLength(1);
    expect(added[0]!.map((f) => f.name)).toEqual(["doc.pdf"]);
  });

  test("a drag that carries no files is ignored (does not enqueue or show the overlay)", async () => {
    let addCalls = 0;
    const attachments = makeAttachments({ addFiles: () => { addCalls += 1; } });
    const container = await mount(<ChatComposer composer={makeComposer()} attachments={attachments} />);
    const field = fieldWrapper(container);
    await act(async () => {
      // A text drag: types is ["text/plain"], no "Files" entry.
      fireDrag(field, "dragover", { types: ["text/plain"] });
      fireDrag(field, "drop", { types: ["text/plain"] });
      await Promise.resolve();
    });
    expect(addCalls).toBe(0);
    expect(container.textContent ?? "").not.toContain("Drop files to attach");
  });

  test("the drop overlay appears on a files-dragover and clears on drop", async () => {
    const attachments = makeAttachments();
    const container = await mount(<ChatComposer composer={makeComposer()} attachments={attachments} />);
    const field = fieldWrapper(container);
    const img = new File(["x"], "shot.png", { type: "image/png" });
    await act(async () => {
      fireDrag(field, "dragover", { files: [img] });
      await Promise.resolve();
    });
    expect(container.textContent ?? "").toContain("Drop files to attach");
    await act(async () => {
      fireDrag(field, "drop", { files: [img] });
      await Promise.resolve();
    });
    expect(container.textContent ?? "").not.toContain("Drop files to attach");
  });

  test("a ChatComposer WITHOUT the attachments prop is not a drop target (dropped files are ignored)", async () => {
    // No attachments prop at all → no addFiles to call; the drop must be inert
    // and must not throw. We assert no overlay and that the textarea still works.
    const container = await mount(<ChatComposer composer={makeComposer()} />);
    const field = fieldWrapper(container);
    const file = new File(["x"], "x.png", { type: "image/png" });
    await act(async () => {
      const event = fireDrag(field, "drop", { files: [file] });
      // Without attachments wired, the handler is not attached, so the event is
      // not preventDefaulted by the composer.
      expect(event.defaultPrevented).toBe(false);
      await Promise.resolve();
    });
    expect(container.textContent ?? "").not.toContain("Drop files to attach");
  });
});
