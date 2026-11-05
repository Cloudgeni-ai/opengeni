/* ----------------------------------------------------------------------------
   An attached image always shows as an image. A draft restored after a reload
   or opened on another device, and a queued message, only carry the stored
   file's id; their pictures must load from the server rather than fall back
   to a generic file chip.
   -------------------------------------------------------------------------- */
import { afterEach, describe, expect, test } from "bun:test";
import type { FileAsset } from "@opengeni/sdk";
import { act, useState, type ReactNode } from "react";
import { ChatComposer } from "../src/components/chat-composer";
import { QueueSurface } from "../src/components/queue-surface";
import { SessionChrome } from "../src/components/session-chrome";
import type { ComposerState } from "../src/hooks/use-composer";
import type { UseTurnQueueResult } from "../src/hooks/use-turn-queue";
import { OpenGeniContext, type OpenGeniContextValue } from "../src/session-context";
import {
  readStoredFilePreviewUrl,
  useStoredFilePreview,
  type StoredFileClientLike,
  type StoredFileSource,
} from "../src/stored-file-preview";
import { LightboxProvider } from "../src/timeline/screenshot-lightbox";
import { fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
  document.body.replaceChildren();
});

function storedFile(id: string, filename: string, contentType: string): FileAsset {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    status: "ready",
    filename,
    safeFilename: filename,
    contentType,
    sizeBytes: 2048,
    sha256: null,
    bucket: "private",
    objectKey: `objects/${id}`,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

const IMAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PDF_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A server holding one image and one PDF; counts reads so caching is visible. */
function storedFilesClient(options: { expiresInMs?: number } = {}) {
  const files = new Map([
    [IMAGE_ID, storedFile(IMAGE_ID, "whiteboard.png", "image/png")],
    [PDF_ID, storedFile(PDF_ID, "quote.pdf", "application/pdf")],
  ]);
  const reads = {
    getFile: [] as string[],
    sign: [] as Array<{ fileId: string; sessionId?: string }>,
  };
  const client = {
    getFile: async (_workspaceId: string, fileId: string) => {
      reads.getFile.push(fileId);
      const file = files.get(fileId);
      if (!file) throw new Error("not found");
      return file;
    },
    createFileDownloadUrl: async (
      _workspaceId: string,
      fileId: string,
      read?: { sessionId?: string },
    ) => {
      reads.sign.push({ fileId, ...(read?.sessionId ? { sessionId: read.sessionId } : {}) });
      return {
        url: `https://files.example/${fileId}?signature=${reads.sign.length}`,
        expiresAt: new Date(Date.now() + (options.expiresInMs ?? 10 * 60_000)).toISOString(),
      };
    },
  } as unknown as StoredFileClientLike;
  return { client, reads };
}

function composer(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    value: "",
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

function queue(overrides: Partial<UseTurnQueueResult> = {}): UseTurnQueueResult {
  return {
    snapshot: null,
    queue: [],
    pendingInputs: [],
    pendingInputAttachment: null,
    effectiveControl: null,
    stoppingPreviousAttempt: false,
    loading: false,
    error: null,
    refresh: async () => {},
    moveTurn: async () => true,
    editTurn: async () => null,
    steerTurn: async () => true,
    removeTurn: async () => true,
    pendingByTurn: {},
    mutationFor: () => null,
    mutating: false,
    mutationError: null,
    clearMutationError: () => {},
    ...overrides,
    activePersonalConnections: overrides.activePersonalConnections ?? [],
  };
}

async function settle(container: HTMLElement, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !done(); attempt += 1) await flush(5);
  void container;
}

function images(container: HTMLElement): HTMLImageElement[] {
  return [...container.querySelectorAll("img")];
}

describe("a draft restored on another device or after a reload", () => {
  test("shows a restored image as its picture, loaded from the server", async () => {
    const { client, reads } = storedFilesClient();
    mounted = await renderComponent(
      <LightboxProvider>
        <ChatComposer
          composer={composer({
            restoredResources: [
              { kind: "file", fileId: IMAGE_ID },
              { kind: "file", fileId: PDF_ID },
            ],
            fileSource: { client, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID },
          })}
        />
      </LightboxProvider>,
    );
    const container = mounted.container;
    await settle(container, () => images(container).length > 0);

    const picture = images(container)[0];
    expect(picture?.getAttribute("src")).toStartWith(`https://files.example/${IMAGE_ID}`);
    // The picture is read as a file of this chat, so a teammate's shared file shows too.
    expect(reads.sign).toEqual([{ fileId: IMAGE_ID, sessionId: SESSION_ID }]);
    expect(container.textContent).toContain("whiteboard.png");
    // Other files keep their own name instead of an opaque id.
    expect(container.textContent).toContain("quote.pdf");
    expect(container.textContent).not.toContain(`File ${IMAGE_ID.slice(0, 8)}`);
    expect(container.textContent).not.toContain(`File ${PDF_ID.slice(0, 8)}`);
  });

  test("removing a restored image removes that resource from the draft", async () => {
    const { client } = storedFilesClient();
    const removed: number[] = [];
    mounted = await renderComponent(
      <ChatComposer
        composer={composer({
          restoredResources: [
            { kind: "file", fileId: PDF_ID },
            { kind: "file", fileId: IMAGE_ID },
          ],
          removeRestoredResource: (index) => removed.push(index),
          fileSource: { client, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID },
        })}
      />,
    );
    const container = mounted.container;
    await settle(container, () => images(container).length > 0);
    const remove = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Remove whiteboard.png",
    );
    expect(remove).toBeDefined();
    await act(async () => remove!.click());
    expect(removed).toEqual([1]);
  });
});

const QUEUE_CONTEXT = {
  client: storedFilesClient().client,
  workspaceId: WORKSPACE_ID,
} as unknown as OpenGeniContextValue;

describe("a queued message", () => {
  test("shows its attached image as a picture in the queue", async () => {
    mounted = await renderComponent(
      <OpenGeniContext.Provider value={QUEUE_CONTEXT}>
        <QueueSurface
          queue={queue({
            queue: [
              fakeTurn({
                prompt: "look at this",
                resources: [
                  { kind: "file", fileId: IMAGE_ID },
                  { kind: "file", fileId: PDF_ID },
                ],
              }),
            ],
          })}
          composer={composer()}
        />
      </OpenGeniContext.Provider>,
    );
    const container = mounted.container;
    await settle(container, () =>
      Boolean(container.querySelector('button[aria-expanded="false"]')),
    );
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(toggle).not.toBeNull();
    await act(async () => toggle!.click());
    await settle(container, () => images(container).length > 0);

    const picture = images(container)[0];
    expect(picture?.getAttribute("src")).toStartWith(`https://files.example/${IMAGE_ID}`);
    expect(picture?.getAttribute("alt")).toBe("whiteboard.png");
    expect(container.textContent).toContain("quote.pdf");
  });

  test("shows its attached image in the session chrome's queue panel", async () => {
    mounted = await renderComponent(
      <OpenGeniContext.Provider value={QUEUE_CONTEXT}>
        <SessionChrome
          queue={queue({
            queue: [
              fakeTurn({
                prompt: "then compare it with this one",
                resources: [{ kind: "file", fileId: IMAGE_ID }],
              }),
            ],
          })}
          composer={composer()}
        />
      </OpenGeniContext.Provider>,
    );
    const container = mounted.container;
    const chip = container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="queue"]',
    );
    expect(chip).not.toBeNull();
    await act(async () => chip!.click());
    await settle(container, () => images(container).length > 0);

    const picture = images(container)[0];
    expect(picture?.getAttribute("src")).toStartWith(`https://files.example/${IMAGE_ID}`);
    expect(picture?.getAttribute("alt")).toBe("whiteboard.png");
  });
});

describe("stored file previews", () => {
  const source = (client: StoredFileClientLike): StoredFileSource => ({
    client,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
  });

  test("every surface showing one file shares a signed URL until shortly before it expires", async () => {
    const fresh = storedFilesClient();
    const first = await readStoredFilePreviewUrl(source(fresh.client), IMAGE_ID);
    expect(await readStoredFilePreviewUrl(source(fresh.client), IMAGE_ID)).toBe(first);
    expect(fresh.reads.sign).toHaveLength(1);

    const expiring = storedFilesClient({ expiresInMs: 30_000 });
    await readStoredFilePreviewUrl(source(expiring.client), IMAGE_ID);
    await readStoredFilePreviewUrl(source(expiring.client), IMAGE_ID);
    expect(expiring.reads.sign).toHaveLength(2);
  });

  test("a local preview that stops loading falls back to the stored copy, then re-signs once", async () => {
    const { client, reads } = storedFilesClient();
    const file = storedFile(IMAGE_ID, "whiteboard.png", "image/png");
    let latest: ReturnType<typeof useStoredFilePreview> | undefined;
    function Probe(): ReactNode {
      const [stableSource] = useState(() => source(client));
      latest = useStoredFilePreview(stableSource, file, { localUrl: "blob:local-photo" });
      return null;
    }
    mounted = await renderComponent(<Probe />);
    expect(latest?.url).toBe("blob:local-photo");
    expect(reads.sign).toHaveLength(0);

    await act(async () => latest!.onError());
    await settle(mounted.container, () => Boolean(latest?.url?.startsWith("https://")));
    expect(latest?.url).toBe(`https://files.example/${IMAGE_ID}?signature=1`);

    await act(async () => latest!.onError());
    await settle(mounted.container, () => latest?.url?.endsWith("signature=2") === true);
    expect(latest?.url).toBe(`https://files.example/${IMAGE_ID}?signature=2`);
    expect(latest?.failed).toBe(false);

    await act(async () => latest!.onError());
    expect(latest?.url).toBeUndefined();
    expect(latest?.failed).toBe(true);
  });
});
