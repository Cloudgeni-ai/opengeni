/* ----------------------------------------------------------------------------
   ChatComposer's opt-in `attachments` prop: the built-in attach button, the
   attachment-chips strip, the paste->addFromPaste wiring, and the send-gate
   that blocks BOTH the button and Enter while files are unresolved.
   -------------------------------------------------------------------------- */
import { afterEach, describe, expect, test } from "bun:test";
import { OpenGeniApiError, OpenGeniSecureContextRequiredError } from "@opengeni/sdk";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer } from "../src/components/chat-composer";
import type { ComposerState } from "../src/hooks/use-composer";
import type { FileAttachment, UseFileAttachmentsResult } from "../src/hooks/use-file-attachments";
import { COMPOSER_PAYMENT_REQUIRED_MESSAGE } from "../src/lib/format";
import { LightboxProvider, useLightboxOptional } from "../src/timeline/screenshot-lightbox";
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
    hasDraftContent: () => true,
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: true,
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
    ...overrides,
  };
}

function makeAttachments(
  overrides: Partial<UseFileAttachmentsResult> = {},
): UseFileAttachmentsResult {
  return {
    attachments: [],
    readyResources: [],
    uploading: false,
    hasUnresolved: false,
    addFiles: () => {},
    addFromPaste: () => {},
    restoreReadyFiles: () => {},
    retry: () => {},
    retainPreview: () => undefined,
    remove: () => {},
    removeReadyFiles: () => {},
    clear: () => {},
    ...overrides,
  };
}

function readyChip(name: string): FileAttachment {
  return {
    id: crypto.randomUUID(),
    name,
    contentType: "image/png",
    sizeBytes: 2048,
    status: "ready",
  };
}

function readyPreviewChip(name: string): FileAttachment {
  return {
    ...readyChip(name),
    previewUrl: `blob:${name}`,
  };
}

function restoredPreviewChip(name: string): FileAttachment {
  return {
    ...readyChip(name),
    file: {
      id: crypto.randomUUID(),
      workspaceId: "workspace-id",
      status: "ready",
      filename: name,
      safeFilename: name,
      contentType: "image/png",
      sizeBytes: 2048,
      sha256: null,
      bucket: "private",
      objectKey: "private",
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
    },
  };
}

type LightboxOpen = NonNullable<ReturnType<typeof useLightboxOptional>>["open"];

function LightboxOpenSpy({ onOpen }: { onOpen: LightboxOpen }) {
  const lightbox = useLightboxOptional();
  useEffect(() => {
    if (!lightbox) return;
    const original = lightbox.open;
    lightbox.open = onOpen;
    return () => {
      lightbox.open = original;
    };
  }, [lightbox, onOpen]);
  return null;
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
    const attach = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Attach files",
    );
    expect(attach).toBeUndefined();
  });

  test("the attach button and hidden file input render in controlsStart when attachments is present", async () => {
    const added: File[][] = [];
    const container = await mount(
      <ChatComposer
        composer={makeComposer()}
        attachments={makeAttachments({
          addFiles: (files) => {
            added.push([...files]);
          },
        })}
      />,
    );
    const attach = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Attach files",
    );
    expect(attach).toBeTruthy();
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    expect(input?.getAttribute("multiple")).not.toBeNull();
    const image = new File(["image"], "chosen.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [image] });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(added).toHaveLength(1);
    expect(added[0]!.map((file) => file.name)).toEqual(["chosen.png"]);
  });

  test("attachment chips render above the textarea when files are attached", async () => {
    const attachments = makeAttachments({ attachments: [readyChip("screenshot.png")] });
    const container = await mount(
      <ChatComposer composer={makeComposer()} attachments={attachments} />,
    );
    expect(container.textContent ?? "").toContain("screenshot.png");
    // The remove control for the chip is present.
    const remove = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Remove screenshot.png",
    );
    expect(remove).toBeTruthy();
  });

  test("renders an image attachment as a shared-lightbox preview trigger", async () => {
    const attachment = readyPreviewChip("screenshot.png");
    const retained: string[] = [];
    const container = await mount(
      <LightboxProvider>
        <ChatComposer
          composer={makeComposer()}
          attachments={makeAttachments({
            attachments: [attachment],
            retainPreview: (id) => {
              retained.push(id);
              return () => {};
            },
          })}
        />
      </LightboxProvider>,
    );

    const preview = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview screenshot.png"]',
    );
    expect(preview).not.toBeNull();
    expect(preview?.querySelector('img[src="blob:screenshot.png"]')).not.toBeNull();
    await act(async () => {
      preview?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(retained).toEqual([attachment.id]);
  });

  test("loads a restored image into the lightbox only when its preview is clicked", async () => {
    const attachment = restoredPreviewChip("restored.png");
    const requested: string[] = [];
    const opened: Parameters<LightboxOpen>[] = [];
    const container = await mount(
      <LightboxProvider>
        <LightboxOpenSpy onOpen={(...args) => opened.push(args)} />
        <ChatComposer
          composer={makeComposer()}
          attachments={makeAttachments({
            attachments: [attachment],
            loadPreview: async (id) => {
              requested.push(id);
              return "https://files.example/restored.png";
            },
          })}
        />
      </LightboxProvider>,
    );

    const preview = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview restored.png"]',
    );
    expect(preview).not.toBeNull();
    expect(requested).toEqual([]);
    await act(async () => {
      preview?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requested).toEqual([attachment.id]);
    expect(opened[0]?.[0]).toBe("https://files.example/restored.png");
  });

  test("replaces a stale unretained blob preview with the durable ready-file source", async () => {
    const attachment = {
      ...restoredPreviewChip("cached.png"),
      previewUrl: "blob:revoked-cached-preview",
    };
    const requested: string[] = [];
    const opened: Parameters<LightboxOpen>[] = [];
    const container = await mount(
      <LightboxProvider>
        <LightboxOpenSpy onOpen={(...args) => opened.push(args)} />
        <ChatComposer
          composer={makeComposer()}
          attachments={makeAttachments({
            attachments: [attachment],
            retainPreview: () => undefined,
            loadPreview: async (id) => {
              requested.push(id);
              return "https://files.example/cached.png";
            },
          })}
        />
      </LightboxProvider>,
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Preview cached.png"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requested).toEqual([attachment.id]);
    expect(opened[0]?.[0]).toBe("https://files.example/cached.png");
  });

  test("a newer local preview aborts and wins over a pending restored preview", async () => {
    const restored = restoredPreviewChip("restored.png");
    const local = readyPreviewChip("local.png");
    let previewSignal: AbortSignal | undefined;
    let resolvePreview!: (src: string) => void;
    const opened: Parameters<LightboxOpen>[] = [];
    const container = await mount(
      <LightboxProvider>
        <LightboxOpenSpy onOpen={(...args) => opened.push(args)} />
        <ChatComposer
          composer={makeComposer()}
          attachments={makeAttachments({
            attachments: [restored, local],
            loadPreview: async (_id, signal) => {
              previewSignal = signal;
              return await new Promise<string>((resolve) => {
                resolvePreview = resolve;
              });
            },
          })}
        />
      </LightboxProvider>,
    );

    const restoredPreview = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview restored.png"]',
    );
    await act(async () => {
      restoredPreview?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(restoredPreview?.disabled).toBe(true);
    expect(restoredPreview?.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Preview local.png"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(previewSignal?.aborted).toBe(true);
    expect(opened.map(([src]) => src)).toEqual(["blob:local.png"]);

    await act(async () => {
      resolvePreview("https://files.example/restored.png");
      await Promise.resolve();
    });
    expect(opened.map(([src]) => src)).toEqual(["blob:local.png"]);
  });

  test("uses composer message overrides for all attachment preview accessible names", async () => {
    const opened: Parameters<LightboxOpen>[] = [];
    const container = await mount(
      <LightboxProvider>
        <LightboxOpenSpy onOpen={(...args) => opened.push(args)} />
        <ChatComposer
          composer={makeComposer()}
          attachments={makeAttachments({ attachments: [readyPreviewChip("screenshot.png")] })}
          messages={{
            previewAttachment: (name) => `Vista previa de ${name}`,
            attachmentPreviewLabel: "Vista previa del archivo adjunto",
            downloadAttachment: (name) => `Descargar ${name}`,
            closeAttachmentPreview: "Cerrar",
          }}
        />
      </LightboxProvider>,
    );

    const preview = container.querySelector<HTMLButtonElement>(
      '[aria-label="Vista previa de screenshot.png"]',
    );
    expect(preview).not.toBeNull();
    expect(container.querySelector('[aria-label="Preview screenshot.png"]')).toBeNull();
    await act(async () => {
      preview?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(opened[0]?.[3]).toBe("Vista previa del archivo adjunto");
    expect(opened[0]?.[5]).toEqual({
      download: "Descargar screenshot.png",
      close: "Cerrar",
    });
  });

  test("degrades an image attachment to a non-interactive thumbnail without a lightbox host", async () => {
    const container = await mount(
      <ChatComposer
        composer={makeComposer()}
        attachments={makeAttachments({ attachments: [readyPreviewChip("screenshot.png")] })}
      />,
    );

    expect(container.querySelector('[aria-label="Preview screenshot.png"]')).toBeNull();
    expect(container.querySelector('img[src="blob:screenshot.png"]')).not.toBeNull();
  });

  test("a managed-credit rejection is actionable and keeps the ready attachment visible", async () => {
    const error = new OpenGeniApiError(
      402,
      JSON.stringify({
        error: {
          status: 402,
          code: "payment_required",
          message: "insufficient OpenGeni credits",
          retryable: false,
        },
      }),
      { mutation: true },
    );
    const container = await mount(
      <ChatComposer
        composer={makeComposer({ error })}
        attachments={makeAttachments({
          attachments: [readyChip("preserved.png")],
          readyResources: [{ kind: "file", fileId: "preserved-file" }],
        })}
      />,
    );

    expect(container.textContent ?? "").toContain(COMPOSER_PAYMENT_REQUIRED_MESSAGE);
    expect(container.textContent ?? "").toContain("preserved.png");
    expect(container.querySelector('[aria-label="Remove preserved.png"]')).not.toBeNull();
    expect(sendButton(container)?.disabled).toBe(false);
  });

  test("while uploading, the send button is disabled and Enter does not call send", async () => {
    let sent = 0;
    const composer = makeComposer({
      send: async () => {
        sent += 1;
        return true;
      },
    });
    const attachments = makeAttachments({
      uploading: true,
      hasUnresolved: true,
      attachments: [{ ...readyChip("a.png"), status: "uploading" }],
    });
    const container = await mount(<ChatComposer composer={composer} attachments={attachments} />);

    expect(sendButton(container)!.disabled).toBe(true);

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(sent).toBe(0);
    await act(async () => {
      sendButton(container)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(sent).toBe(0);
  });

  test("a failed attachment blocks the send button and Enter instead of being silently omitted", async () => {
    let sent = 0;
    const composer = makeComposer({
      send: async () => {
        sent += 1;
        return true;
      },
    });
    const attachments = makeAttachments({
      hasUnresolved: true,
      attachments: [
        {
          ...readyChip("failed.png"),
          status: "failed",
          error: "storage unavailable",
        },
      ],
    });
    const container = await mount(<ChatComposer composer={composer} attachments={attachments} />);

    expect(sendButton(container)!.disabled).toBe(true);
    expect(container.querySelector('[aria-label="Retry failed.png"]')).not.toBeNull();
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      sendButton(container)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(sent).toBe(0);
  });

  test("shows secure-context guidance directly on the failed card without a futile retry", async () => {
    const failure = new OpenGeniSecureContextRequiredError("insecure_context");
    const attachments = makeAttachments({
      hasUnresolved: true,
      attachments: [
        {
          ...readyChip("dragged.png"),
          status: "failed",
          errorCode: failure.code,
          error: failure.message,
        },
      ],
    });
    const container = await mount(
      <ChatComposer composer={makeComposer()} attachments={attachments} />,
    );

    expect(container.textContent ?? "").toContain(
      "Couldn’t attach this file because OpenGeni is open over HTTP.",
    );
    expect(container.textContent ?? "").toContain(
      "Open the secure site or configure HTTPS for this deployment.",
    );
    expect(container.querySelector('[aria-label="Retry dragged.png"]')).toBeNull();
    expect(container.querySelector('[aria-label="Remove dragged.png"]')).not.toBeNull();
    expect(sendButton(container)?.disabled).toBe(true);
  });

  test("removing the failed attachment unblocks send without dropping the typed prompt", async () => {
    let sent = 0;
    function Harness() {
      const [failed, setFailed] = useState(true);
      return (
        <ChatComposer
          composer={makeComposer({
            send: async () => {
              sent += 1;
              return true;
            },
          })}
          attachments={makeAttachments({
            hasUnresolved: failed,
            attachments: failed
              ? [{ ...readyChip("failed.png"), status: "failed", error: "try again" }]
              : [],
            remove: () => setFailed(false),
          })}
        />
      );
    }
    const container = await mount(<Harness />);
    expect(sendButton(container)!.disabled).toBe(true);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove failed.png"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(sendButton(container)!.disabled).toBe(false);

    await act(async () => {
      container
        .querySelector("textarea")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
    expect(sent).toBe(1);
  });

  test("with uploads settled, Enter sends and the button is enabled", async () => {
    let sent = 0;
    const composer = makeComposer({
      send: async () => {
        sent += 1;
        return true;
      },
    });
    const attachments = makeAttachments({
      uploading: false,
      attachments: [readyChip("a.png")],
      readyResources: [{ kind: "file", fileId: "f1" }],
    });
    const container = await mount(<ChatComposer composer={composer} attachments={attachments} />);

    expect(sendButton(container)!.disabled).toBe(false);
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(sent).toBe(1);
  });

  test("send is ENABLED with a ready attachment even when the draft is empty (file-only message)", async () => {
    // A composer over an empty draft reports canSend=false; the ready attachment
    // is what makes the message sendable, and ChatComposer ORs it in.
    const composer = makeComposer({ value: "", canSend: false });
    const attachments = makeAttachments({
      attachments: [readyChip("a.png")],
      readyResources: [{ kind: "file", fileId: "f1" }],
    });
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
      hasUnresolved: true,
      attachments: [readyChip("ready.png"), { ...readyChip("pending.png"), status: "uploading" }],
      readyResources: [{ kind: "file", fileId: "f1" }],
    });
    const container = await mount(<ChatComposer composer={composer} attachments={attachments} />);
    expect(sendButton(container)!.disabled).toBe(true);
  });

  test("pasting into the textarea routes the clipboard through addFromPaste (and still calls host onPaste)", async () => {
    let pastedThroughHook = 0;
    let hostPaste = 0;
    const attachments = makeAttachments({
      addFromPaste: () => {
        pastedThroughHook += 1;
      },
    });
    const container = await mount(
      <ChatComposer
        composer={makeComposer()}
        attachments={attachments}
        onPaste={() => {
          hostPaste += 1;
        }}
      />,
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
    const attachments = makeAttachments({
      addFiles: (files) => {
        added.push([...files]);
      },
    });
    const container = await mount(
      <ChatComposer composer={makeComposer()} attachments={attachments} />,
    );
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
    const attachments = makeAttachments({
      addFiles: () => {
        addCalls += 1;
      },
    });
    const container = await mount(
      <ChatComposer composer={makeComposer()} attachments={attachments} />,
    );
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
    const container = await mount(
      <ChatComposer composer={makeComposer()} attachments={attachments} />,
    );
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
