import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  ChatFileDropCover,
  ChatFileDropRelay,
  ChatFileDropRelayProvider,
  ChatViewportFileDropTarget,
} from "@opengeni/react/app/components/session/chat-viewport-file-drop-target";
import { registerDom } from "../../../../../packages/react/test/render-hook";

registerDom();

let mounted: { root: Root; container: HTMLElement } | null = null;

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await act(async () => current.root.unmount());
  current.container.remove();
});

async function mount(onFiles: (files: FileList) => void): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ChatViewportFileDropTarget
        data-workspace-scroll-owner="self-managed"
        enabled
        onFiles={onFiles}
      >
        <div data-testid="timeline">
          <span data-testid="nested">Conversation</span>
        </div>
      </ChatViewportFileDropTarget>,
    );
  });
  mounted = { root, container };
  return container;
}

function fireDrag(
  target: HTMLElement,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  files: File[],
): DragEvent {
  const fileList = {
    ...files,
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: () => files[Symbol.iterator](),
  } as unknown as FileList;
  const dataTransfer = {
    types: ["Files"],
    files: fileList,
    dropEffect: "none",
  } as unknown as DataTransfer;
  const event = new DragEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer, configurable: true });
  target.dispatchEvent(event);
  return event;
}

describe("ChatViewportFileDropTarget", () => {
  test("forwards the route-declared scroll ownership marker to its root", async () => {
    const container = await mount(() => {});
    const viewport = container.querySelector<HTMLElement>(
      '[data-testid="chat-viewport-drop-target"]',
    );

    expect(viewport?.getAttribute("data-workspace-scroll-owner")).toBe("self-managed");
    expect(viewport?.hasAttribute("data-og-conversation")).toBe(true);
  });

  test("shows one full-viewport overlay without flicker across nested enter/leave events", async () => {
    const container = await mount(() => {});
    const viewport = container.querySelector<HTMLElement>(
      '[data-testid="chat-viewport-drop-target"]',
    )!;
    const nested = container.querySelector<HTMLElement>('[data-testid="nested"]')!;
    const file = new File(["x"], "shot.png", { type: "image/png" });

    await act(async () => {
      fireDrag(viewport, "dragenter", [file]);
      fireDrag(nested, "dragenter", [file]);
      fireDrag(nested, "dragleave", [file]);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="chat-viewport-drop-overlay"]')).not.toBeNull();

    await act(async () => {
      fireDrag(viewport, "dragleave", [file]);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="chat-viewport-drop-overlay"]')).toBeNull();
  });

  test("accepts a file dropped over the timeline and clears the overlay", async () => {
    const added: string[][] = [];
    const container = await mount((files) => added.push([...files].map((file) => file.name)));
    const nested = container.querySelector<HTMLElement>('[data-testid="nested"]')!;
    const file = new File(["x"], "shot.png", { type: "image/png" });

    await act(async () => {
      fireDrag(nested, "dragenter", [file]);
      fireDrag(nested, "drop", [file]);
      await Promise.resolve();
    });

    expect(added).toEqual([["shot.png"]]);
    expect(container.querySelector('[data-testid="chat-viewport-drop-overlay"]')).toBeNull();
  });

  test("does not upload a second time when a child drop target already handled the event", async () => {
    let calls = 0;
    const container = await mount(() => {
      calls += 1;
    });
    const nested = container.querySelector<HTMLElement>('[data-testid="nested"]')!;
    nested.addEventListener("drop", (event) => event.preventDefault());
    const file = new File(["x"], "shot.png", { type: "image/png" });

    await act(async () => {
      fireDrag(nested, "drop", [file]);
      await Promise.resolve();
    });

    expect(calls).toBe(0);
  });
});

describe("ChatFileDropRelay", () => {
  async function mountBeside(onFiles: (files: FileList) => void, enabled: boolean) {
    const relay = new ChatFileDropRelay();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const draw = (chatEnabled: boolean) =>
      act(async () => {
        root.render(
          <>
            <div data-testid="beside">
              <ChatFileDropCover relay={relay} enabled />
            </div>
            <ChatFileDropRelayProvider relay={relay}>
              <ChatViewportFileDropTarget
                data-workspace-scroll-owner="self-managed"
                enabled={chatEnabled}
                onFiles={onFiles}
              >
                <div />
              </ChatViewportFileDropTarget>
            </ChatFileDropRelayProvider>
          </>,
        );
      });
    await draw(enabled);
    mounted = { root, container };
    return { container, relay, draw };
  }
  const coverOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-testid="chat-file-drop-cover"]');
  const overlayOf = (container: HTMLElement) =>
    container.querySelector('[data-testid="chat-viewport-drop-overlay"]');

  test("a chat takes the files dropped beside it only while it takes files itself", async () => {
    const added: string[][] = [];
    const { container, relay, draw } = await mountBeside(
      (files) => added.push([...files].map((file) => file.name)),
      false,
    );
    const file = new File(["x"], "shot.png", { type: "image/png" });
    expect(relay.current()).toBeNull();
    await act(async () => void fireDrag(document.body, "dragenter", [file]));
    expect(coverOf(container)).toBeNull();
    await draw(true);
    expect(relay.current()).not.toBeNull();
    await act(async () => void fireDrag(document.body, "dragover", [file]));
    const cover = coverOf(container)!;
    await act(async () => void fireDrag(cover, "dragover", [file]));
    expect(overlayOf(container)).not.toBeNull();
    await act(async () => void fireDrag(cover, "drop", [file]));
    expect(added).toEqual([["shot.png"]]);
    expect(overlayOf(container)).toBeNull();
    // Turned off again, it stops taking them.
    await draw(false);
    expect(relay.current()).toBeNull();
  });

  test("the cover goes once the drag has left the page", async () => {
    const { container } = await mountBeside(() => {}, true);
    const file = new File(["x"], "shot.png", { type: "image/png" });
    await act(async () => void fireDrag(document.body, "dragenter", [file]));
    expect(coverOf(container)).not.toBeNull();
    // No more drag events from this page: the pointer is outside the window.
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 1100))));
    expect(coverOf(container)).toBeNull();
  });
});
