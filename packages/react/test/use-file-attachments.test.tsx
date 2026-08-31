/* ----------------------------------------------------------------------------
   Rendered-hook tests for useFileAttachments — the SDK-owned client-side upload
   layer: object-URL preview lifecycle, the image/* paste filter, the
   uploading->ready/failed status machine, the FileResourceRef projection, and
   distinct progress (`uploading`) and loss-prevention (`hasUnresolved`) gates.
   -------------------------------------------------------------------------- */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenGeniSecureContextRequiredError, type FileAsset } from "@opengeni/sdk";
import { act, startTransition, Suspense } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
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
    expect(revoked.filter((candidate) => candidate === url)).toHaveLength(1);
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
    expect(
      created.every((url) => revoked.filter((candidate) => candidate === url).length === 1),
    ).toBe(true);
  });

  test("same-batch addFiles plus unmount revokes a preview before state commits", async () => {
    const client = fakeClient({ uploadFile: () => new Promise<FileAsset>(() => {}) });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let result!: ReturnType<typeof useFileAttachments>;

    function Harness() {
      result = useFileAttachments({ client, workspaceId: WORKSPACE_ID });
      return null;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => {
      result.addFiles([imageFile()]);
      root.unmount();
    });
    container.remove();

    expect(created).toHaveLength(1);
    expect(revoked).toEqual(created);
  });

  test("unmount revokes outstanding previews and ignores a late upload settlement", async () => {
    let resolveUpload!: (asset: FileAsset) => void;
    const client = fakeClient({
      uploadFile: () =>
        new Promise<FileAsset>((resolve) => {
          resolveUpload = resolve;
        }),
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile()]));
    const preview = hook.result.current.attachments[0]!.previewUrl!;
    await hook.unmount();
    expect(revoked).toContain(preview);

    await flushing(() => resolveUpload(fakeAsset()));
    expect(revoked.filter((url) => url === preview)).toHaveLength(1);
  });

  test("workspace changes clear attachments and fence the previous upload", async () => {
    let resolveUpload!: (asset: FileAsset) => void;
    const client = fakeClient({
      uploadFile: () =>
        new Promise<FileAsset>((resolve) => {
          resolveUpload = resolve;
        }),
    });
    const hook = await renderHook(
      ({ workspaceId }: { workspaceId: string }) => useFileAttachments({ client, workspaceId }),
      { workspaceId: WORKSPACE_ID },
    );

    await flushing(() => hook.result.current.addFiles([imageFile()]));
    const preview = hook.result.current.attachments[0]!.previewUrl!;
    await hook.rerender({ workspaceId: "workspace-next" });

    expect(hook.result.current.attachments).toEqual([]);
    expect(hook.result.current.readyResources).toEqual([]);
    expect(revoked).toContain(preview);

    await flushing(() =>
      resolveUpload(fakeAsset({ id: "old-workspace-file", workspaceId: WORKSPACE_ID })),
    );
    expect(hook.result.current.attachments).toEqual([]);
    expect(hook.result.current.readyResources).toEqual([]);
    await hook.unmount();
    expect(revoked.filter((url) => url === preview)).toHaveLength(1);
  });

  test("client changes clear attachments and fence the previous upload", async () => {
    let resolveUpload!: (asset: FileAsset) => void;
    const previousClient = fakeClient({
      uploadFile: () =>
        new Promise<FileAsset>((resolve) => {
          resolveUpload = resolve;
        }),
    });
    const nextClient = fakeClient({ uploadFile: async () => fakeAsset() });
    const hook = await renderHook(
      ({ client }: { client: typeof previousClient }) =>
        useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      { client: previousClient },
    );

    await flushing(() => hook.result.current.addFiles([imageFile()]));
    const preview = hook.result.current.attachments[0]!.previewUrl!;
    await hook.rerender({ client: nextClient });

    expect(hook.result.current.attachments).toEqual([]);
    expect(hook.result.current.readyResources).toEqual([]);
    expect(revoked).toContain(preview);

    await flushing(() => resolveUpload(fakeAsset({ id: "old-client-file" })));
    expect(hook.result.current.attachments).toEqual([]);
    expect(hook.result.current.readyResources).toEqual([]);
    await hook.unmount();
    expect(revoked.filter((url) => url === preview)).toHaveLength(1);
  });

  test("removeReadyFiles clears only the accepted snapshot and preserves later attachments", async () => {
    let upload = 0;
    const client = fakeClient({
      uploadFile: async () => {
        upload += 1;
        return fakeAsset({ id: upload === 1 ? "accepted-file" : "later-file" });
      },
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile("accepted.png")]));
    await flush();
    const acceptedIds = hook.result.current.readyResources.map((resource) => resource.fileId);
    const acceptedPreview = hook.result.current.attachments[0]!.previewUrl!;

    // This attachment was not part of the already-dispatched request and must
    // remain available for the next message after that request succeeds.
    await flushing(() => hook.result.current.addFiles([imageFile("later.png")]));
    await flush();
    const laterPreview = hook.result.current.attachments[1]!.previewUrl!;
    await flushing(() => hook.result.current.removeReadyFiles(acceptedIds));

    expect(hook.result.current.readyResources).toEqual([{ kind: "file", fileId: "later-file" }]);
    expect(hook.result.current.attachments.map((attachment) => attachment.name)).toEqual([
      "asset.png",
    ]);
    expect(revoked).toContain(acceptedPreview);
    expect(revoked).not.toContain(laterPreview);
    await hook.unmount();
  });

  test("send removal keeps an open preview URL alive until its lease releases", async () => {
    const asset = fakeAsset({ id: "sent-file" });
    const client = fakeClient({ uploadFile: async () => asset });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile("sent.png")]));
    await flush();
    const attachment = hook.result.current.attachments[0]!;
    const previewUrl = attachment.previewUrl!;
    const releasePreview = hook.result.current.retainPreview(attachment.id);

    expect(releasePreview).toBeFunction();
    await flushing(() => hook.result.current.removeReadyFiles([asset.id]));
    expect(hook.result.current.attachments).toEqual([]);
    expect(revoked).not.toContain(previewUrl);

    releasePreview?.();
    releasePreview?.();
    expect(revoked.filter((url) => url === previewUrl)).toHaveLength(1);
    await hook.unmount();
    expect(revoked.filter((url) => url === previewUrl)).toHaveLength(1);
  });

  test("explicit attachment removal keeps an open preview alive until close", async () => {
    const client = fakeClient({ uploadFile: async () => fakeAsset() });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile("removed.png")]));
    const attachment = hook.result.current.attachments[0]!;
    const previewUrl = attachment.previewUrl!;
    const releasePreview = hook.result.current.retainPreview(attachment.id);

    await flushing(() => hook.result.current.remove(attachment.id));
    expect(hook.result.current.attachments).toEqual([]);
    expect(revoked).not.toContain(previewUrl);

    releasePreview?.();
    expect(revoked.filter((url) => url === previewUrl)).toHaveLength(1);
    await hook.unmount();
  });

  test("clear and hook unmount defer retained preview cleanup until every holder releases", async () => {
    const client = fakeClient({ uploadFile: async () => fakeAsset() });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile("retained.png")]));
    const attachment = hook.result.current.attachments[0]!;
    const previewUrl = attachment.previewUrl!;
    const releaseFirst = hook.result.current.retainPreview(attachment.id);
    const releaseSecond = hook.result.current.retainPreview(attachment.id);

    await flushing(() => hook.result.current.clear());
    expect(hook.result.current.attachments).toEqual([]);
    expect(revoked).not.toContain(previewUrl);

    releaseFirst?.();
    expect(revoked).not.toContain(previewUrl);
    await hook.unmount();
    expect(revoked).not.toContain(previewUrl);

    releaseSecond?.();
    expect(revoked.filter((url) => url === previewUrl)).toHaveLength(1);
  });

  for (const operation of ["restoreReadyFiles", "removeReadyFiles"] as const) {
    test(`${operation} does not revoke a committed preview from an abandoned render`, async () => {
      const asset = fakeAsset({ id: `${operation}-ready` });
      const client = fakeClient({ uploadFile: async () => asset });
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const suspended = new Promise<never>(() => {});
      const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
      let blockEmpty = false;
      let renderedRemoval = false;
      let unmounted = false;
      let result!: ReturnType<typeof useFileAttachments>;

      function Harness() {
        result = useFileAttachments({ client, workspaceId: WORKSPACE_ID });
        if (blockEmpty && result.attachments.length === 0) {
          renderedRemoval = true;
          throw suspended;
        }
        const previewUrl = result.attachments[0]?.previewUrl;
        return previewUrl ? <img alt="preview" src={previewUrl} /> : null;
      }

      try {
        flushSync(() => {
          root.render(
            <Suspense fallback={null}>
              <Harness />
            </Suspense>,
          );
        });
        flushSync(() => result.addFiles([imageFile()]));
        await new Promise((resolve) => setTimeout(resolve, 30));

        const previewUrl = result.attachments[0]!.previewUrl!;
        expect(result.readyResources).toEqual([{ kind: "file", fileId: asset.id }]);
        expect(container.querySelector("img")?.getAttribute("src")).toBe(previewUrl);

        blockEmpty = true;
        startTransition(() => {
          if (operation === "restoreReadyFiles") {
            result.restoreReadyFiles([]);
          } else {
            result.removeReadyFiles([asset.id]);
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(renderedRemoval).toBe(true);
        expect(container.querySelector("img")?.getAttribute("src")).toBe(previewUrl);
        expect(revoked).not.toContain(previewUrl);

        flushSync(() => root.unmount());
        unmounted = true;
        expect(revoked.filter((url) => url === previewUrl)).toHaveLength(1);
      } finally {
        if (!unmounted) flushSync(() => root.unmount());
        container.remove();
        globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    });
  }

  test("addFromPaste applies the default image/* filter — only the image is enqueued", async () => {
    const asset = fakeAsset();
    const client = fakeClient({ uploadFile: async () => asset });
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
    expect(hook.result.current.readyResources).toEqual([{ kind: "file", fileId: asset.id }]);
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
    expect(hook.result.current.hasUnresolved).toBe(false);
    await hook.unmount();
  });

  test("drops retry source bytes once an upload finalizes", async () => {
    let calls = 0;
    const client = fakeClient({
      uploadFile: async () => {
        calls += 1;
        return fakeAsset();
      },
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile()]));
    await flush();
    await flushing(() => hook.result.current.retry(hook.result.current.attachments[0]!.id));
    await flush();
    expect(calls).toBe(1);
    await hook.unmount();
  });

  test("restores only same-workspace ready assets without previews or duplicate ids", async () => {
    let resolveUpload!: (asset: FileAsset) => void;
    const client = fakeClient({
      uploadFile: () =>
        new Promise<FileAsset>((resolve) => {
          resolveUpload = resolve;
        }),
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flushing(() => hook.result.current.addFiles([imageFile("still-uploading.png")]));
    const ready = fakeAsset({ id: "restored-ready", filename: "restored.png" });

    await flushing(() =>
      hook.result.current.restoreReadyFiles([
        ready,
        { ...ready },
        fakeAsset({ id: "not-ready", status: "failed" }),
        fakeAsset({ id: "foreign", workspaceId: "other-workspace" }),
      ]),
    );

    expect(hook.result.current.attachments).toHaveLength(2);
    expect(hook.result.current.attachments[0]).toMatchObject({
      name: "still-uploading.png",
      status: "uploading",
    });
    expect(hook.result.current.attachments[1]).toEqual({
      id: "restored:restored-ready:default",
      name: "restored.png",
      contentType: ready.contentType,
      sizeBytes: ready.sizeBytes,
      status: "ready",
      file: ready,
      resource: { kind: "file", fileId: "restored-ready" },
      restored: true,
    });
    expect(hook.result.current.attachments[1]?.previewUrl).toBeUndefined();
    expect(hook.result.current.uploading).toBe(true);
    expect(hook.result.current.readyResources).toEqual([
      { kind: "file", fileId: "restored-ready" },
    ]);

    await flushing(() => resolveUpload(fakeAsset({ id: "local-ready" })));
    await hook.unmount();
  });

  test("hydrates a durable image into one named card with a signed preview", async () => {
    const asset = fakeAsset({ id: "durable-image", filename: "durable.png", sizeBytes: 4096 });
    const getFileCalls: string[] = [];
    const downloadCalls: string[] = [];
    const client = fakeClient({
      uploadFile: async () => asset,
      getFile: async (_workspaceId, fileId) => {
        getFileCalls.push(fileId);
        return asset;
      },
      createFileDownloadUrl: async (_workspaceId, fileId) => {
        downloadCalls.push(fileId);
        return {
          url: "https://files.example.test/durable-image",
          expiresAt: "2026-08-12T12:00:00.000Z",
        };
      },
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() =>
      hook.result.current.restoreResources?.([{ kind: "file", fileId: asset.id }]),
    );
    await flush();

    expect(hook.result.current.attachments).toHaveLength(1);
    expect(hook.result.current.attachments[0]).toMatchObject({
      id: "restored:durable-image:default",
      name: "durable.png",
      contentType: "image/png",
      sizeBytes: 4096,
      status: "ready",
      file: asset,
      resource: { kind: "file", fileId: asset.id },
      restored: true,
      previewUrl: "https://files.example.test/durable-image",
    });
    expect(hook.result.current.attachments[0]?.metadataStatus).toBeUndefined();
    expect(hook.result.current.readyResources).toEqual([{ kind: "file", fileId: asset.id }]);
    expect(getFileCalls).toEqual([asset.id]);
    expect(downloadCalls).toEqual([asset.id]);

    await flushing(() =>
      hook.result.current.restoreResources?.([{ kind: "file", fileId: asset.id }]),
    );
    await flush();
    expect(getFileCalls).toEqual([asset.id]);
    expect(downloadCalls).toEqual([asset.id]);
    await hook.unmount();
  });

  test("preserves exact custom mounts while hydrating shared file metadata once", async () => {
    const asset = fakeAsset({ id: "shared-file", filename: "shared.png" });
    let getFileCalls = 0;
    let downloadCalls = 0;
    const client = fakeClient({
      uploadFile: async () => asset,
      getFile: async () => {
        getFileCalls += 1;
        return asset;
      },
      createFileDownloadUrl: async () => {
        downloadCalls += 1;
        return {
          url: "https://files.example.test/shared",
          expiresAt: "2026-08-12T12:00:00.000Z",
        };
      },
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    const resources = [
      { kind: "file", fileId: asset.id, mountPath: "input/one.png" },
      { kind: "file", fileId: asset.id, mountPath: "input/two.png" },
      { kind: "file", fileId: asset.id, mountPath: "input/one.png" },
    ] as const;

    await flushing(() => hook.result.current.restoreResources?.(resources));
    await flush();

    expect(hook.result.current.attachments).toHaveLength(2);
    expect(hook.result.current.attachments.map((attachment) => attachment.resource)).toEqual(
      resources.slice(0, 2),
    );
    expect(hook.result.current.attachments.map((attachment) => attachment.previewUrl)).toEqual([
      "https://files.example.test/shared",
      "https://files.example.test/shared",
    ]);
    expect(hook.result.current.readyResources).toEqual(resources.slice(0, 2));
    expect(getFileCalls).toBe(1);
    expect(downloadCalls).toBe(1);
    await hook.unmount();
  });

  test("exact accepted mount cleanup preserves a later mount of the same file", async () => {
    const asset = fakeAsset({ id: "mounted-file", filename: "mounted.png" });
    const client = fakeClient({ uploadFile: async () => asset });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    const accepted = { kind: "file", fileId: asset.id, mountPath: "inputs/accepted.png" } as const;
    const later = { kind: "file", fileId: asset.id, mountPath: "inputs/later.png" } as const;

    await flushing(() => hook.result.current.restoreReadyFiles([asset], [accepted, later]));
    await flushing(() => hook.result.current.removeReadyFiles([accepted]));

    expect(hook.result.current.attachments).toHaveLength(1);
    expect(hook.result.current.attachments[0]?.resource).toEqual(later);
    expect(hook.result.current.readyResources).toEqual([later]);
    await hook.unmount();
  });

  test("a stale metadata request cannot resurrect an older durable resource set", async () => {
    let resolveFirst!: (file: FileAsset) => void;
    let resolveSecond!: (file: FileAsset) => void;
    const first = new Promise<FileAsset>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<FileAsset>((resolve) => {
      resolveSecond = resolve;
    });
    const client = fakeClient({
      uploadFile: async () => fakeAsset(),
      getFile: async (_workspaceId, fileId) => await (fileId === "first-durable" ? first : second),
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() =>
      hook.result.current.restoreResources?.([{ kind: "file", fileId: "first-durable" }]),
    );
    await flushing(() =>
      hook.result.current.restoreResources?.([{ kind: "file", fileId: "second-durable" }]),
    );
    await flushing(() =>
      resolveSecond(fakeAsset({ id: "second-durable", filename: "second.png" })),
    );
    await flush();
    await flushing(() => resolveFirst(fakeAsset({ id: "first-durable", filename: "first.png" })));
    await flush();

    expect(hook.result.current.attachments).toHaveLength(1);
    expect(hook.result.current.attachments[0]).toMatchObject({
      name: "second.png",
      resource: { kind: "file", fileId: "second-durable" },
    });
    expect(hook.result.current.readyResources).toEqual([
      { kind: "file", fileId: "second-durable" },
    ]);
    await hook.unmount();
  });

  test("soft reconciliation preserves the local object URL and does not mint a signed preview", async () => {
    const asset = fakeAsset({ id: "local-image", filename: "local.png" });
    let downloadCalls = 0;
    const client = fakeClient({
      uploadFile: async () => asset,
      createFileDownloadUrl: async () => {
        downloadCalls += 1;
        return {
          url: "https://files.example.test/local-image",
          expiresAt: "2026-08-12T12:00:00.000Z",
        };
      },
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile("local.png")]));
    await flush();
    const attachmentId = hook.result.current.attachments[0]!.id;
    const localPreview = hook.result.current.attachments[0]!.previewUrl;

    await flushing(() =>
      hook.result.current.restoreReadyFiles([asset], [{ kind: "file", fileId: asset.id }]),
    );
    await flush();

    expect(hook.result.current.attachments).toHaveLength(1);
    expect(hook.result.current.attachments[0]).toMatchObject({
      id: attachmentId,
      file: asset,
      resource: { kind: "file", fileId: asset.id },
      previewUrl: localPreview,
    });
    expect(downloadCalls).toBe(0);
    expect(revoked).not.toContain(localPreview);
    await hook.unmount();
  });

  test("a minimal upload-only client degrades a durable ref to one coherent fallback card", async () => {
    const client = fakeClient({ uploadFile: async () => fakeAsset() });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() =>
      hook.result.current.restoreResources?.([{ kind: "file", fileId: "fallback-file" }]),
    );

    expect(hook.result.current.attachments).toEqual([
      {
        id: "restored:fallback-file:default",
        name: "fallback-file",
        contentType: "application/octet-stream",
        sizeBytes: 0,
        status: "ready",
        resource: { kind: "file", fileId: "fallback-file" },
        restored: true,
        metadataStatus: "failed",
      },
    ]);
    expect(hook.result.current.readyResources).toEqual([{ kind: "file", fileId: "fallback-file" }]);
    await hook.unmount();
  });

  test("a failed signed preview keeps hydrated image metadata and falls back safely", async () => {
    const asset = fakeAsset({ id: "broken-preview", filename: "still-named.png" });
    const client = fakeClient({
      uploadFile: async () => asset,
      getFile: async () => asset,
      createFileDownloadUrl: async () => {
        throw new Error("signing unavailable");
      },
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() =>
      hook.result.current.restoreResources?.([{ kind: "file", fileId: asset.id }]),
    );
    await flush();

    expect(hook.result.current.attachments[0]).toMatchObject({
      name: "still-named.png",
      contentType: "image/png",
      file: asset,
      previewFailed: true,
    });
    expect(hook.result.current.attachments[0]?.previewUrl).toBeUndefined();
    await hook.unmount();
  });

  test("a later server restoration replaces the ready set but preserves unresolved uploads", async () => {
    let resolveUpload!: (asset: FileAsset) => void;
    const client = fakeClient({
      uploadFile: () =>
        new Promise<FileAsset>((resolve) => {
          resolveUpload = resolve;
        }),
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flushing(() => hook.result.current.addFiles([imageFile("pending.png")]));
    const first = fakeAsset({ id: "first-ready", filename: "first.txt" });
    const second = fakeAsset({ id: "second-ready", filename: "second.txt" });
    await flushing(() => hook.result.current.restoreReadyFiles([first]));
    await flushing(() => hook.result.current.restoreReadyFiles([second]));
    expect(hook.result.current.attachments.map((attachment) => attachment.status)).toEqual([
      "uploading",
      "ready",
    ]);
    expect(hook.result.current.readyResources).toEqual([{ kind: "file", fileId: "second-ready" }]);

    await flushing(() => hook.result.current.restoreReadyFiles([]));
    expect(hook.result.current.attachments).toHaveLength(1);
    expect(hook.result.current.attachments[0]?.status).toBe("uploading");
    await flushing(() => resolveUpload(fakeAsset({ id: "local-ready" })));
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
    expect(hook.result.current.hasUnresolved).toBe(true);

    await flushing(() => hook.result.current.remove(attachment.id));
    expect(hook.result.current.attachments).toEqual([]);
    expect(hook.result.current.hasUnresolved).toBe(false);
    await hook.unmount();
  });

  test("classifies a typed secure-context upload failure for the attachment card", async () => {
    const failure = new OpenGeniSecureContextRequiredError("insecure_context");
    const client = fakeClient({
      uploadFile: async () => {
        throw failure;
      },
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile("dragged.png")]));
    await flush();

    expect(hook.result.current.attachments[0]).toMatchObject({
      name: "dragged.png",
      status: "failed",
      errorCode: "secure_context_required",
      error: failure.message,
    });
    expect(hook.result.current.hasUnresolved).toBe(true);
    await hook.unmount();
  });

  test("tracks the failed attachment when insecure HTTP withholds crypto.randomUUID", async () => {
    const randomUuidDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    const failure = new OpenGeniSecureContextRequiredError("insecure_context");
    let uploads = 0;
    const client = fakeClient({
      uploadFile: async () => {
        uploads += 1;
        throw failure;
      },
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    try {
      await flushing(() => hook.result.current.addFiles([imageFile("http.png")]));
      await flush();

      expect(uploads).toBe(1);
      expect(hook.result.current.attachments).toHaveLength(1);
      expect(hook.result.current.attachments[0]).toMatchObject({
        name: "http.png",
        status: "failed",
        errorCode: "secure_context_required",
        error: failure.message,
      });
      expect(hook.result.current.hasUnresolved).toBe(true);
    } finally {
      await hook.unmount();
      if (randomUuidDescriptor) {
        Object.defineProperty(globalThis.crypto, "randomUUID", randomUuidDescriptor);
      } else {
        Reflect.deleteProperty(globalThis.crypto, "randomUUID");
      }
    }
  });

  test("classifies the stable secure-context code from a structurally compatible client", async () => {
    const failure = Object.assign(new Error("Use HTTPS"), {
      code: "secure_context_required" as const,
      retryable: false,
    });
    const client = fakeClient({
      uploadFile: async () => {
        throw failure;
      },
    });
    const hook = await renderHook(
      () => useFileAttachments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(() => hook.result.current.addFiles([imageFile("embedded.png")]));
    await flush();

    expect(hook.result.current.attachments[0]).toMatchObject({
      name: "embedded.png",
      status: "failed",
      errorCode: "secure_context_required",
      error: "Use HTTPS",
    });
    await hook.unmount();
  });

  test("retry(id) re-uploads a failed attachment in place -> ready, clearing its error", async () => {
    let calls = 0;
    let resolveRetry!: (value: FileAsset) => void;
    const retryResult = new Promise<FileAsset>((resolve) => {
      resolveRetry = resolve;
    });
    const asset = fakeAsset({ id: "recovered", filename: "recovered.png" });
    const client = fakeClient({
      uploadFile: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient network error");
        }
        return await retryResult;
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
    expect(hook.result.current.attachments[0]!.status).toBe("uploading");
    expect(hook.result.current.uploading).toBe(true);
    expect(hook.result.current.hasUnresolved).toBe(true);

    await flushing(() => resolveRetry(asset));
    await flush();
    const attachment = hook.result.current.attachments[0]!;
    expect(attachment.status).toBe("ready");
    expect(attachment.error).toBeUndefined();
    expect(hook.result.current.readyResources).toEqual([{ kind: "file", fileId: asset.id }]);
    expect(hook.result.current.hasUnresolved).toBe(false);
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
    expect(hook.result.current.hasUnresolved).toBe(true);

    await flushing(() => resolveUpload(fakeAsset()));
    expect(hook.result.current.uploading).toBe(false);
    expect(hook.result.current.hasUnresolved).toBe(false);
    await hook.unmount();
  });
});
