/* ----------------------------------------------------------------------------
   A user message shows what was attached to it, the way it looked in the
   composer: an image as a thumbnail that opens larger, any other file as a
   named chip that opens it. This holds for history, for a message still on
   its way (optimistic) and for a steer the queue accepted.
   -------------------------------------------------------------------------- */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { FileAsset, ResourceRef, SessionEvent } from "@opengeni/sdk";
import { act, useEffect } from "react";
import { MessageTimeline } from "../src";
import type { OpenGeniLinkResolver } from "../src/components/open-geni-links";
import { conversationTimeline } from "../src/conversation-timeline";
import { createOpenGeniText } from "../src/messages/runtime";
import type { StoredFileClientLike } from "../src/stored-file-preview";
import { buildTimeline } from "../src/timeline/projection";
import { LightboxProvider, useLightboxOptional } from "../src/timeline/screenshot-lightbox";
import type { TimelineItem } from "../src/timeline/types";
import { SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

const t = createOpenGeniText();
let mounted: RenderedComponent | null = null;
let lightboxOpens: Array<{ src: string; caption: string | undefined; label: string | undefined }> = [];

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
  lightboxOpens = [];
  document.body.replaceChildren();
});

/** Records what the timeline asks its lightbox to open. */
function LightboxOpenSpy() {
  const lightbox = useLightboxOptional();
  useEffect(() => {
    if (!lightbox) return;
    const original = lightbox.open;
    lightbox.open = (src, caption, _source, label) => {
      lightboxOpens.push({ src, caption, label });
    };
    return () => {
      lightbox.open = original;
    };
  }, [lightbox]);
  return null;
}

const IMAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PDF_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GONE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const image: ResourceRef = { kind: "file", fileId: IMAGE_ID, mountPath: "/workspace/in/shot.png" };
const pdf: ResourceRef = { kind: "file", fileId: PDF_ID };

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

/** A server with one screenshot and one PDF; records every read. */
function filesClient() {
  const files = new Map([
    [IMAGE_ID, storedFile(IMAGE_ID, "screenshot.png", "image/png")],
    [PDF_ID, storedFile(PDF_ID, "quote.pdf", "application/pdf")],
  ]);
  const signed: Array<{ fileId: string; sessionId?: string | undefined }> = [];
  const client = {
    getFile: async (_workspaceId: string, fileId: string) => {
      const file = files.get(fileId);
      if (!file) throw new Error("not found");
      return file;
    },
    createFileDownloadUrl: async (
      _workspaceId: string,
      fileId: string,
      read?: { sessionId?: string },
    ) => {
      signed.push({ fileId, sessionId: read?.sessionId });
      return {
        url: `https://files.example/${fileId}?signature=${signed.length}`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    },
  } as unknown as StoredFileClientLike;
  return { client, signed };
}

async function renderTimeline(
  items: TimelineItem[],
  options: { resolveLink?: OpenGeniLinkResolver; client?: StoredFileClientLike } = {},
) {
  const client = options.client ?? filesClient().client;
  mounted = await renderComponent(
    <LightboxProvider>
      <LightboxOpenSpy />
      <MessageTimeline
        items={items}
        artifactScope={{ client, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID }}
        {...(options.resolveLink ? { resolveLink: options.resolveLink } : {})}
      />
    </LightboxProvider>,
  );
  await flush();
  await flush();
  await flush();
  return mounted.container;
}

function historyMessage(resources: ResourceRef[]): TimelineItem[] {
  const event = {
    id: "evt-1",
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence: 1,
    type: "user.message",
    payload: { text: "for example this one, can you fix it?", resources },
    occurredAt: "2026-11-09T13:50:00.000Z",
    turnId: "turn-1",
  } as unknown as SessionEvent;
  return buildTimeline(t, [event]);
}

function button(container: HTMLElement, name: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === name,
    ) ?? null
  );
}

describe("a sent message's attachments", () => {
  test("history shows an image as a thumbnail that opens larger and a file as a named chip", async () => {
    const { client, signed } = filesClient();
    const opened: string[] = [];
    const container = await renderTimeline(historyMessage([image, pdf]), {
      client,
      resolveLink: (target) =>
        target.kind === "file" ? { open: () => void opened.push(target.fileId) } : null,
    });

    const attachments = container.querySelector("[data-og-message-attachments]");
    expect(attachments).not.toBeNull();
    // Above the bubble, in the order they were attached.
    expect(attachments?.textContent).toBe("screenshot.png2.0 KBquote.pdf2.0 KB");

    const preview = button(container, "Preview screenshot.png");
    expect(preview).not.toBeNull();
    const thumbnail = preview?.querySelector("img");
    expect(thumbnail?.getAttribute("src")).toStartWith(`https://files.example/${IMAGE_ID}`);
    // Read in the conversation, so a file shared into the chat resolves.
    expect(signed[0]).toEqual({ fileId: IMAGE_ID, sessionId: SESSION_ID });

    await act(async () => preview!.click());
    await flush();
    expect(lightboxOpens).toEqual([
      {
        src: thumbnail!.getAttribute("src")!,
        caption: "screenshot.png",
        label: "Attachment preview",
      },
    ]);

    // Files open through the host's link resolution, like an artifact link.
    const file = button(container, "Open quote.pdf");
    expect(file).not.toBeNull();
    await act(async () => file!.click());
    await flush();
    expect(opened).toEqual([PDF_ID]);
  });

  test("without a host resolver a file downloads through a short-lived link", async () => {
    const { client, signed } = filesClient();
    const clicks: string[] = [];
    const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        clicks.push(this.href);
      },
    );
    try {
      const container = await renderTimeline(historyMessage([pdf]), { client });
      await act(async () => button(container, "Open quote.pdf")!.click());
      await flush();
    } finally {
      click.mockRestore();
    }
    expect(signed).toEqual([{ fileId: PDF_ID, sessionId: SESSION_ID }]);
    expect(clicks).toEqual([`https://files.example/${PDF_ID}?signature=1`]);
  });

  test("a message still being sent shows its attachments", async () => {
    const items = conversationTimeline(
      [],
      { queue: [], snapshot: null },
      {
        optimisticMessages: [
          {
            clientEventId: "client-1",
            delivery: "send",
            destination: "chat",
            text: "for example this one",
            annotations: [],
            resources: [image, pdf],
            occurredAt: "2026-11-09T13:54:00.000Z",
            state: "sending",
          },
        ],
      },
    );
    expect(items.map((item) => item.id)).toEqual(["optimistic:client-1"]);
    const container = await renderTimeline(items);
    expect(button(container, "Preview screenshot.png")?.querySelector("img")).not.toBeNull();
    expect(button(container, "Open quote.pdf")).not.toBeNull();
  });

  test("an accepted steer shows its attachments", async () => {
    const items = conversationTimeline(
      [],
      {
        queue: [],
        snapshot: null,
        acceptedSteers: [
          {
            turnId: "turn-2",
            triggerEventId: "evt-steer",
            text: "and this one",
            annotations: [],
            resources: [image, pdf],
            tools: [],
            occurredAt: "2026-11-09T13:55:00.000Z",
            state: "queued",
          },
        ],
      },
      {},
    );
    expect(items.map((item) => item.id)).toEqual(["evt-steer"]);
    const container = await renderTimeline(items);
    expect(button(container, "Preview screenshot.png")?.querySelector("img")).not.toBeNull();
    expect(button(container, "Open quote.pdf")).not.toBeNull();
  });

  test("a file that can no longer be read stays visible as unavailable", async () => {
    const container = await renderTimeline(
      historyMessage([{ kind: "file", fileId: GONE_ID }, pdf]),
    );
    const attachments = container.querySelector("[data-og-message-attachments]");
    expect(attachments?.textContent).toBe("File ccccccccUnavailablequote.pdf2.0 KB");
    // Nothing to open: only the readable file is a control.
    expect(attachments?.querySelectorAll("button, a")).toHaveLength(1);
  });

  test("a message without files adds nothing above its bubble", async () => {
    const container = await renderTimeline(
      historyMessage([
        { kind: "repository", uri: "https://github.com/example/project.git", ref: "main" },
      ]),
    );
    expect(container.querySelector("[data-og-message-attachments]")).toBeNull();
  });
});
