import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { createMemoryRecordingChunkStore, type StoredRecording } from "@opengeni/sdk/recordings";

// The Radix dialog is a portal; this inline stand-in keeps its contract.
mock.module("@opengeni/react/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    title,
    description,
    confirmLabel,
    cancelLabel,
    onOpenChange,
    onConfirm,
  }: {
    title: ReactNode;
    description?: ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => unknown;
  }) => (
    <div role="dialog">
      <h2>{title}</h2>
      <p>{description}</p>
      <button type="button" onClick={() => onOpenChange(false)}>
        {cancelLabel}
      </button>
      <button
        type="button"
        onClick={() => {
          void (async () => {
            if ((await onConfirm()) !== false) onOpenChange(false);
          })();
        }}
      >
        {confirmLabel}
      </button>
    </div>
  ),
}));

const { SignOutRecordingsDialog } = await import("./sign-out-recordings-dialog");
const { prepareRecordingsForSignOut } = await import("@opengeni/react/meetings-recorder");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const pending = (recordingId: string): StoredRecording => ({
  workspaceId: "workspace",
  recordingId,
  ownerId: "ola@example.com",
  create: {
    recordingId,
    startedAt: "2026-11-10T08:00:00.000Z",
    tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
  },
  created: true,
  phase: "stopped",
  endedAt: "2026-11-10T08:30:00.000Z",
  chunkCounts: { 0: 1 },
  updatedAt: 0,
});

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SignOutRecordingsDialog />));
  return {
    container,
    unmount: () => act(async () => root.unmount()),
    click: async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === label,
      )!;
      await act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("SignOutRecordingsDialog", () => {
  test("Wait for upload keeps the person signed in with their recording", async () => {
    const view = await mount();
    const store = createMemoryRecordingChunkStore();
    await store.putRecording(pending("meeting"));
    const signingOut = prepareRecordingsForSignOut("ola@example.com", { store });
    await flush();
    expect(view.container.querySelector("h2")?.textContent).toBe("Recordings are still uploading");
    expect(view.container.querySelector("p")?.textContent).toBe(
      "A recording on this device hasn't finished uploading. Signing out now deletes it.",
    );
    await view.click("Wait for upload");
    expect(await signingOut).toBe(false);
    expect(await store.listRecordings()).toHaveLength(1);
    expect(view.container.querySelector("[role=dialog]")).toBeNull();
    await view.unmount();
  });

  test("Discard and sign out removes the recordings, then signing out goes on", async () => {
    const view = await mount();
    const store = createMemoryRecordingChunkStore();
    await store.putRecording(pending("one"));
    await store.putRecording(pending("two"));
    const signingOut = prepareRecordingsForSignOut("ola@example.com", { store });
    await flush();
    expect(view.container.querySelector("p")?.textContent).toBe(
      "Recordings on this device haven't finished uploading. Signing out now deletes them.",
    );
    await view.click("Discard and sign out");
    expect(await signingOut).toBe(true);
    expect(await store.listRecordings()).toEqual([]);
    await view.unmount();
  });
});
