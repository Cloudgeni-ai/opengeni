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

describe("native attachment upload scope", () => {
  test("a private chat's uploads are Only me; without a scope the server decides", async () => {
    for (const scope of ["personal", "workspace", undefined] as const) {
      const sent: Array<Record<string, unknown>> = [];
      const recording = {
        uploadFile: async (_workspaceId: string, input: Record<string, unknown>) => {
          sent.push(input);
          return asset("doc-1");
        },
      } as unknown as FileAttachmentClientLike;
      const hook = await renderHook(
        () =>
          useNativeFileAttachments({
            client: recording,
            workspaceId: "workspace-1",
            sessionId: "session-1",
            scope,
            files: { ...files, readBytes: async () => new Uint8Array([1, 2, 3]) },
            crypto,
          }),
        undefined,
      );
      await act(async () =>
        hook.result.current.addFiles([
          {
            id: "doc-1",
            uri: "file:///doc-1.txt",
            name: "doc-1.txt",
            contentType: "text/plain",
            sizeBytes: 3,
            kind: "document",
          },
        ]),
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]!.scope).toBe(scope);
      await hook.unmount();
    }
  });
});

describe("native streamed video upload", () => {
  const clip = {
    id: "clip-1",
    uri: "file:///IMG_0042.MOV",
    name: "IMG_0042.MOV",
    contentType: "video/quicktime",
    sizeBytes: 734_003_200,
    kind: "video" as const,
    durationSeconds: 42.5,
  };

  test("streams from disk unhashed, shows its progress and becomes ready", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let report: (fraction: number) => void = () => undefined;
    let finishPut: () => void = () => undefined;
    const streaming = {
      uploadFile: async (_workspaceId: string, input: Record<string, unknown>) => {
        sent.push(input);
        const data = input.data as { send(target: unknown): Promise<{ status: number }> };
        await data.send({ url: "https://storage.example.test", headers: {}, sizeBytes: 1 });
        return { ...asset("video-1"), contentType: "video/quicktime", filename: clip.name };
      },
    } as unknown as FileAttachmentClientLike;
    const hook = await renderHook(
      () =>
        useNativeFileAttachments({
          client: streaming,
          workspaceId: "workspace-1",
          sessionId: "session-1",
          files: {
            ...files,
            readBytes: async () => {
              throw new Error("a long video must never be read into memory");
            },
            uploadSource: (_file, onProgress) => {
              report = onProgress;
              return {
                sizeBytes: 734_003_200,
                send: () => new Promise((resolve) => (finishPut = () => resolve({ status: 200 }))),
              };
            },
          },
          crypto,
        }),
      undefined,
    );
    let adding: Promise<void> = Promise.resolve();
    await act(async () => {
      adding = hook.result.current.addFiles([clip]);
      await Promise.resolve();
    });
    expect(hook.result.current.attachments[0]).toMatchObject({
      kind: "video",
      durationSeconds: 42.5,
      status: "uploading",
      progress: 0,
    });
    await act(async () => {
      report(0.421);
      report(0.425);
    });
    expect(hook.result.current.attachments[0]!.progress).toBe(0.42);
    await act(async () => {
      finishPut();
      await adding;
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sha256).toBeUndefined();
    expect(sent[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(hook.result.current.attachments[0]).toMatchObject({ status: "ready" });
    expect(hook.result.current.attachments[0]!.progress).toBeUndefined();
    expect(hook.result.current.readyResources).toEqual([{ kind: "file", fileId: "video-1" }]);
    await hook.unmount();
  });

  test("removing a video mid-upload stops its transfer", async () => {
    let signal: AbortSignal | undefined;
    const streaming = {
      uploadFile: (_workspaceId: string, input: Record<string, unknown>) => {
        signal = input.signal as AbortSignal;
        return new Promise<FileAsset>((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(new Error("cancelled"))),
        );
      },
    } as unknown as FileAttachmentClientLike;
    const hook = await renderHook(
      () =>
        useNativeFileAttachments({
          client: streaming,
          workspaceId: "workspace-1",
          sessionId: "session-1",
          files: {
            ...files,
            uploadSource: () => ({ sizeBytes: 734_003_200, send: async () => ({ status: 200 }) }),
          },
          crypto,
        }),
      undefined,
    );
    await act(async () => {
      void hook.result.current.addFiles([clip]);
      await Promise.resolve();
    });
    expect(signal?.aborted).toBe(false);
    await act(async () => hook.result.current.remove(clip.id));
    expect(signal?.aborted).toBe(true);
    expect(hook.result.current.attachments).toEqual([]);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });

  test("leaving the chat stops uploads still in flight", async () => {
    let signal: AbortSignal | undefined;
    const streaming = {
      uploadFile: (_workspaceId: string, input: Record<string, unknown>) => {
        signal = input.signal as AbortSignal;
        return new Promise<FileAsset>(() => undefined);
      },
    } as unknown as FileAttachmentClientLike;
    const hook = await renderHook(
      () =>
        useNativeFileAttachments({
          client: streaming,
          workspaceId: "workspace-1",
          sessionId: "session-1",
          files: {
            ...files,
            uploadSource: () => ({ sizeBytes: 734_003_200, send: async () => ({ status: 200 }) }),
          },
          crypto,
        }),
      undefined,
    );
    await act(async () => {
      void hook.result.current.addFiles([clip]);
      await Promise.resolve();
    });
    await hook.unmount();
    expect(signal?.aborted).toBe(true);
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
