/* ----------------------------------------------------------------------------
   Rendered-hook tests for useFileAttachments — the SDK-owned client-side upload
   layer: object-URL preview lifecycle, the image/* paste filter, the
   uploading->ready/failed status machine, the FileResourceRef projection, and
   the single `uploading` boolean the composer's send-gate reads.
   -------------------------------------------------------------------------- */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FileAsset } from "@opengeni/sdk";
import { act } from "react";
import { useFileAttachments } from "../src/hooks/use-file-attachments";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderHook } from "./render-hook";

registerDom();

/** Run a callback inside act-flushed microtasks so state updates settle. */
async function flushing(run: () => Promise<void> | void): Promise<void> {
  await act(async () => {
    await run();
  });
}

function fakeAsset(overrides: Partial<FileAsset> = {}): FileAsset {
  return {
    id: crypto.randomUUID(),
    workspaceId: WORKSPACE_ID,
    status: "ready",
    filename: "asset.png",
    safeFilename: "asset.png",
    contentType: "image/png",
    sizeBytes: 1234,
    sha256: null,
    bucket: "b",
    objectKey: "k",
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}

function imageFile(name = "shot.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function textFile(name = "notes.txt"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "text/plain" });
}

// Spy on the object-URL lifecycle. happy-dom may or may not provide these; we
// fully replace them so create/revoke calls are deterministically counted.
let created: string[] = [];
let revoked: string[] = [];
let originalCreate: typeof URL.createObjectURL | undefined;
let originalRevoke: typeof URL.revokeObjectURL | undefined;
let urlCounter = 0;

beforeEach(() => {
  created = [];
  revoked = [];
  urlCounter = 0;
  originalCreate = URL.createObjectURL;
  originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((_obj: unknown) => {
    const url = `blob:mock/${urlCounter++}`;
    created.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
});

afterEach(() => {
  if (originalCreate) {
    URL.createObjectURL = originalCreate;
  }
  if (originalRevoke) {
    URL.revokeObjectURL = originalRevoke;
  }
});

describe("useFileAttachments", () => {
  test("an image/* file mints exactly one object-URL preview", async () => {
    const client = fakeClient({ uploadFile: async () => fakeAsset() });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile()]));
    expect(created.length).toBe(1);
    expect(hook.result.current.attachments).toHaveLength(1);
    expect(hook.result.current.attachments[0]?.previewUrl).toBe(created[0]);
    await hook.unmount();
  });

  test("a non-image file mints NO object-URL (previewUrl undefined)", async () => {
    const client = fakeClient({ uploadFile: async () => fakeAsset({ contentType: "text/plain" }) });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([textFile()]));
    expect(created.length).toBe(0);
    expect(hook.result.current.attachments[0]?.previewUrl).toBeUndefined();
    await hook.unmount();
  });

  test("remove(id) revokes the attachment's object-URL", async () => {
    const client = fakeClient({ uploadFile: async () => fakeAsset() });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile()]));
    const id = hook.result.current.attachments[0]!.id;
    const url = hook.result.current.attachments[0]!.previewUrl!;

    await flushing(() => hook.result.current.remove(id));
    expect(hook.result.current.attachments).toHaveLength(0);
    expect(revoked).toContain(url);
    await hook.unmount();
  });

  test("clear() revokes every outstanding object-URL", async () => {
    const client = fakeClient({ uploadFile: async () => fakeAsset() });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile("a.png"), imageFile("b.png")]));
    expect(created.length).toBe(2);

    await flushing(() => hook.result.current.clear());
    expect(hook.result.current.attachments).toHaveLength(0);
    expect(revoked.sort()).toEqual(created.slice().sort());
    await hook.unmount();
  });

  test("addFromPaste applies the default image/* filter — only the image is enqueued", async () => {
    const client = fakeClient({ uploadFile: async () => fakeAsset() });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    const clipboardData = {
      files: [imageFile("pasted.png"), textFile("pasted.txt")],
    } as unknown as DataTransfer;
    await flushing(() => hook.result.current.addFromPaste({ clipboardData }));
    expect(hook.result.current.attachments).toHaveLength(1);
    expect(hook.result.current.attachments[0]?.contentType).toBe("image/png");
    await hook.unmount();
  });

  test("a custom pasteFilter governs instead of the image/* default", async () => {
    const client = fakeClient({ uploadFile: async () => fakeAsset({ contentType: "text/plain" }) });
    const hook = await renderHook(
      () =>
        useFileAttachments({
          client,
          workspaceId: WORKSPACE_ID,
          pasteFilter: (f) => f.type === "text/plain",
        }),
      undefined,
    );

    const clipboardData = {
      files: [imageFile("pasted.png"), textFile("pasted.txt")],
    } as unknown as DataTransfer;
    await flushing(() => hook.result.current.addFromPaste({ clipboardData }));
    expect(hook.result.current.attachments).toHaveLength(1);
    expect(hook.result.current.attachments[0]?.contentType).toBe("text/plain");
    await hook.unmount();
  });

  test("a ready upload flips status->ready and projects into readyResources", async () => {
    const asset = fakeAsset({ filename: "uploaded.png", sizeBytes: 9999 });
    const client = fakeClient({ uploadFile: async () => asset });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile()]));
    // Let the upload promise settle.
    await flush();
    const attachment = hook.result.current.attachments[0]!;
    expect(attachment.status).toBe("ready");
    expect(attachment.name).toBe("uploaded.png");
    expect(attachment.sizeBytes).toBe(9999);
    expect(hook.result.current.readyResources).toEqual([{ kind: "file", fileId: asset.id }]);
    expect(hook.result.current.uploading).toBe(false);
    await hook.unmount();
  });

  test("a rejected upload flips status->failed, sets error, and is excluded from readyResources", async () => {
    const client = fakeClient({
      uploadFile: async () => {
        throw new Error("blob storage exploded");
      },
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile()]));
    await flush();
    const attachment = hook.result.current.attachments[0]!;
    expect(attachment.status).toBe("failed");
    expect(attachment.error).toBe("blob storage exploded");
    expect(hook.result.current.readyResources).toEqual([]);
    expect(hook.result.current.uploading).toBe(false);
    await hook.unmount();
  });

  test("retry(id) re-uploads a failed attachment in place -> ready, clearing its error", async () => {
    let calls = 0;
    const asset = fakeAsset({ id: "recovered", filename: "recovered.png" });
    const client = fakeClient({
      uploadFile: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient network error");
        }
        return asset;
      },
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile()]));
    await flush();
    const id = hook.result.current.attachments[0]!.id;
    expect(hook.result.current.attachments[0]!.status).toBe("failed");
    expect(hook.result.current.attachments[0]!.error).toBe("transient network error");

    await flushing(() => hook.result.current.retry(id));
    await flush();
    const attachment = hook.result.current.attachments[0]!;
    expect(attachment.status).toBe("ready");
    expect(attachment.error).toBeUndefined();
    expect(hook.result.current.readyResources).toEqual([{ kind: "file", fileId: asset.id }]);
    expect(calls).toBe(2);
    await hook.unmount();
  });

  test("retry(id) is a no-op for an unknown / already-removed id", async () => {
    const client = fakeClient({ uploadFile: async () => fakeAsset() });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.retry("nope"));
    await flush();
    expect(hook.result.current.attachments).toHaveLength(0);
    await hook.unmount();
  });

  test("uploading is true while an upload is pending and flips false once it resolves", async () => {
    let resolveUpload!: (asset: FileAsset) => void;
    const pending = new Promise<FileAsset>((resolve) => {
      resolveUpload = resolve;
    });
    const client = fakeClient({ uploadFile: () => pending });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile()]));
    expect(hook.result.current.uploading).toBe(true);

    await flushing(() => resolveUpload(fakeAsset()));
    expect(hook.result.current.uploading).toBe(false);
    await hook.unmount();
  });
});
