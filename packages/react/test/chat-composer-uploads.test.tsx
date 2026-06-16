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
});
