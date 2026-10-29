// The Site view's new chat uses the regular composer: a screenshot pasted
// into it or dropped anywhere on it is attached, as in any chat.
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { NewConversationController } from "../../../hooks/use-new-conversation";

const added: string[][] = [];
let pasted = 0;
let uploadsEnabled = true;
let useNewConversationOptions: Record<string, unknown> | undefined;

const composer = {
  value: "",
  setValue: () => {},
  hasDraftContent: () => false,
  send: async () => true,
  steer: async () => true,
  sending: false,
  canSend: false,
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
const files = {
  attachments: [],
  readyResources: [],
  uploading: false,
  hasUnresolved: false,
  addFiles: (list: FileList | File[]) => added.push([...list].map((file) => file.name)),
  addFromPaste: () => void pasted++,
  restoreReadyFiles: () => {},
  retry: () => {},
  retainPreview: () => undefined,
  remove: () => {},
  removeReadyFiles: () => {},
  clear: () => {},
};

mock.module("../../../hooks/use-new-conversation", () => ({
  useNewConversation: (options: Record<string, unknown>) => {
    useNewConversationOptions = options;
    return {
      client: {},
      workspaceId: "workspace-1",
      composer,
      catalog: { rows: [], loading: false, error: null, refresh: async () => {} },
      files,
      uploadsEnabled,
      available: true,
      realtimeVoiceEnabled: false,
      pending: null,
      error: null,
      finishingUploads: false,
      retry: async () => {},
      startRealtime: async () => {},
    } as unknown as NewConversationController;
  },
}));
mock.module("../../app-context", () => ({
  useAppContext: () => ({ workspaces: [], clientConfig: {}, client: {} }),
}));
// The usage line reads the person's usage; not what this test is about.
mock.module("../usage/usage-entry", () => ({ ComposerUsageNotice: () => null }));

let module: typeof import("./console-new-conversation");
let ownsDom = false;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  module = await import("./console-new-conversation");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  added.length = 0;
  pasted = 0;
  uploadsEnabled = true;
});

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <module.ConsoleNewConversation
        workspaceId="workspace-1"
        title="Ask about Opengeni usage"
        createSession={async () => "session-1"}
      />,
    );
  });
  return container;
}

function fireFileDrag(target: Element, type: "dragenter" | "dragover" | "drop", list: File[]) {
  const fileList = Object.assign([...list], { item: (index: number) => list[index] ?? null });
  const event = new DragEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files: fileList, dropEffect: "none" },
  });
  target.dispatchEvent(event);
  return event;
}

test("a screenshot pasted into the Site's new chat is attached", async () => {
  const container = await render();
  expect(container.textContent).toContain("Ask about Opengeni usage");
  // The regular composer, with the model chip and attachments.
  expect(useNewConversationOptions).toMatchObject({ modelPicker: true });
  expect(container.querySelector("button[aria-label='Attach files']")).not.toBeNull();
  const input = container.querySelector("textarea")!;
  await act(async () => {
    input.focus();
    input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true }));
  });
  expect(pasted).toBe(1);
});

test("a screenshot dropped anywhere on the new chat, not only its input, is attached", async () => {
  const container = await render();
  const title = [...container.querySelectorAll("p")].find(
    (element) => element.textContent === "Ask about Opengeni usage",
  )!;
  const shot = new File(["png"], "Screenshot.png", { type: "image/png" });
  await act(async () => void fireFileDrag(title, "dragenter", [shot]));
  expect(container.querySelector("[data-testid='chat-viewport-drop-overlay']")).not.toBeNull();
  let drop: DragEvent | undefined;
  await act(async () => void (drop = fireFileDrag(title, "drop", [shot])));
  expect(drop!.defaultPrevented).toBe(true);
  expect(added).toEqual([["Screenshot.png"]]);
  expect(container.querySelector("[data-testid='chat-viewport-drop-overlay']")).toBeNull();
});

test("where uploads are off, the new chat takes no files", async () => {
  uploadsEnabled = false;
  const container = await render();
  expect(container.querySelector("button[aria-label='Attach files']")).toBeNull();
  const shot = new File(["png"], "Screenshot.png", { type: "image/png" });
  await act(async () => void fireFileDrag(container.querySelector("form")!, "drop", [shot]));
  expect(added).toEqual([]);
});
