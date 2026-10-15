import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { FileAsset, SendMessageInput } from "@opengeni/sdk";
import type { FileAttachmentClientLike } from "@opengeni/react/session";
import { registerDom, renderHook } from "../../react/test/render-hook";
import type { NativeCryptoAdapter, NativeFileAdapter } from "../src/adapters";
import {
  nativeComposerAttachmentCallbacks,
  removeReadyNativeAttachments,
  useNativeFileAttachments,
  type NativeAttachment,
} from "../src/attachments";

registerDom();

const client = {
  uploadFile: async () => {
    throw new Error("not used");
  },
} as unknown as FileAttachmentClientLike;
const files: NativeFileAdapter = {
  pickDocuments: async () => [],
  pickImages: async () => [],
  readBytes: async () => new Uint8Array(),
};
const crypto: NativeCryptoAdapter = {
  randomUUID: () => "uuid",
  sha256Hex: async () => "a".repeat(64),
};

function asset(id: string): FileAsset {
  return {
    id,
    workspaceId: "workspace-1",
    filename: `${id}.jpg`,
    contentType: "image/jpeg",
    sizeBytes: 3,
    status: "ready",
  } as FileAsset;
}

function sendInput(fileIds: string[]): SendMessageInput {
  return {
    text: "(see attached context)",
    resources: fileIds.map((fileId) => ({ kind: "file" as const, fileId })),
  } as SendMessageInput;
}

function useTrayWithComposerCallbacks() {
  const attachments = useNativeFileAttachments({
    client,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    files,
    crypto,
  });
  return { attachments, callbacks: nativeComposerAttachmentCallbacks(attachments) };
}

describe("native composer attachment tray", () => {
  test("a locally acknowledged Send removes its photos at once, so a second tap cannot resend them", async () => {
    const hook = await renderHook(useTrayWithComposerCallbacks, undefined);
    await act(async () => hook.result.current.attachments.restoreReady([asset("photo-1")]));
    expect(hook.result.current.attachments.readyResources).toEqual([
      { kind: "file", fileId: "photo-1" },
    ]);

    // The composer acknowledges an ordinary Send locally through onSubmitted;
    // server acceptance (onSent) can arrive seconds later.
    await act(async () =>
      hook.result.current.callbacks.onSubmitted("photo", sendInput(["photo-1"])),
    );

    expect(hook.result.current.attachments.readyResources).toEqual([]);
    await hook.unmount();
  });

  test("acceptance removes only the files that send captured", async () => {
    const hook = await renderHook(useTrayWithComposerCallbacks, undefined);
    await act(async () =>
      hook.result.current.attachments.restoreReady([asset("photo-1"), asset("photo-2")]),
    );

    await act(async () => hook.result.current.callbacks.onSent("photo", sendInput(["photo-1"])));

    expect(hook.result.current.attachments.readyResources).toEqual([
      { kind: "file", fileId: "photo-2" },
    ]);
    await hook.unmount();
  });
});

describe("removeReadyNativeAttachments", () => {
  test("keeps unfinished uploads and unrelated ready files", () => {
    const current: NativeAttachment[] = [
      {
        id: "a",
        name: "a",
        contentType: "image/jpeg",
        sizeBytes: 1,
        kind: "image",
        status: "ready",
        file: asset("photo-1"),
      },
      {
        id: "b",
        name: "b",
        contentType: "image/jpeg",
        sizeBytes: 1,
        kind: "image",
        status: "uploading",
      },
      {
        id: "c",
        name: "c",
        contentType: "image/jpeg",
        sizeBytes: 1,
        kind: "image",
        status: "ready",
        file: asset("photo-3"),
      },
    ];
    expect(removeReadyNativeAttachments(current, ["photo-1"]).map((entry) => entry.id)).toEqual([
      "b",
      "c",
    ]);
    expect(removeReadyNativeAttachments(current, [])).toBe(current);
    expect(removeReadyNativeAttachments(current, ["missing"])).toBe(current);
  });
});
