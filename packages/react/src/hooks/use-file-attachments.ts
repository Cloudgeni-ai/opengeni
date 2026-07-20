import type { FileAsset, FileResourceRef } from "@opengeni/sdk";
import { useCallback, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

export type UseFileAttachmentsOptions = ClientOverride & {
  /**
   * Only files matching this predicate are accepted by {@link
   * UseFileAttachmentsResult.addFromPaste} (the clipboard path). Defaults to
   * `image/*` — the console's historical paste filter. {@link
   * UseFileAttachmentsResult.addFiles} (the explicit picker / drop path)
   * bypasses it.
   */
  pasteFilter?: ((file: File) => boolean) | undefined;
};

export type FileAttachment = {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  status: "uploading" | "ready" | "failed";
  /** The SDK `FileAsset` once the upload finishes. */
  file?: FileAsset | undefined;
  /** Object-URL for an inline preview; minted for `image/*` files only. */
  previewUrl?: string | undefined;
  error?: string | undefined;
};

export type UseFileAttachmentsResult = {
  attachments: FileAttachment[];
  /**
   * `FileResourceRef[]` for every attachment that finished uploading — feed
   * straight into `useComposer`'s `sendExtras.resources`.
   */
  readyResources: FileResourceRef[];
  /** True while any attachment is still uploading (drives the send-gate). */
  uploading: boolean;
  /** Explicit picker / drop path — uploads every file, no filter. */
  addFiles: (files: Iterable<File>) => void;
  /** Clipboard path — applies `pasteFilter` (default `image/*`) then uploads. */
  addFromPaste: (event: { clipboardData: DataTransfer | null }) => void;
  /** Restore already-ready server assets without recreating browser-local bytes. */
  restoreReadyFiles: (files: Iterable<FileAsset>) => void;
  /**
   * Re-run the upload for a `failed` attachment, in place (same id, same
   * source file). No-op for an id that isn't a known failed upload.
   */
  retry: (id: string) => void;
  /** Remove one attachment; revokes its object-URL. */
  remove: (id: string) => void;
  /** Remove all; revokes every object-URL. Call from `useComposer`'s `onSent`. */
  clear: () => void;
};

const isImage = (file: File): boolean => file.type.startsWith("image/");

/**
 * Upload-and-track state for files attached to the next message. Owns the
 * full client-side upload layer: a per-file `uploading | ready | failed`
 * status machine driven by the SDK's `client.uploadFile`, object-URL image
 * previews with create/revoke lifecycle, the `image/*` clipboard paste filter,
 * and a `FileResourceRef[]` projection that drops straight into a message's
 * `resources`. Workspace-scoped, so it resolves both client and workspace from
 * the {@link OpenGeniProvider} (or a per-call `{ client, workspaceId }`).
 */
export function useFileAttachments(
  options: UseFileAttachmentsOptions = {},
): UseFileAttachmentsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const pasteFilter = options.pasteFilter ?? isImage;
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  // Keep the source File per attachment id so a failed upload can be retried
  // in place. Cleared on remove/clear so it never outlives its attachment.
  const sources = useRef<Map<string, File>>(new Map());

  // Run (or re-run) the upload for one already-tracked attachment id. Sets it
  // back to `uploading`, then resolves to `ready` (with the asset) or `failed`
  // (with the error message).
  const startUpload = useCallback(
    (id: string, file: File) => {
      void client
        .uploadFile(workspaceId, {
          filename: file.name || "file",
          contentType: file.type || "application/octet-stream",
          data: file,
        })
        .then((asset) => {
          // Retry bytes are useful only until durable finalization succeeds.
          // Drop the source File immediately; restored/ready attachments must
          // never retain browser-local byte authority.
          sources.current.delete(id);
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id
                ? {
                    ...attachment,
                    status: "ready",
                    file: asset,
                    name: asset.filename,
                    contentType: asset.contentType,
                    sizeBytes: asset.sizeBytes,
                    error: undefined,
                  }
                : attachment,
            ),
          );
        })
        .catch((error: unknown) => {
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id
                ? {
                    ...attachment,
                    status: "failed",
                    error: error instanceof Error ? error.message : String(error),
                  }
                : attachment,
            ),
          );
        });
    },
    [client, workspaceId],
  );

  const addFiles = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        const id = crypto.randomUUID();
        sources.current.set(id, file);
        const previewUrl = isImage(file) ? URL.createObjectURL(file) : undefined;
        setAttachments((current) => [
          ...current,
          {
            id,
            name: file.name || "image",
            contentType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            status: "uploading",
            ...(previewUrl ? { previewUrl } : {}),
          },
        ]);
        startUpload(id, file);
      }
    },
    [startUpload],
  );

  const retry = useCallback(
    (id: string) => {
      const file = sources.current.get(id);
      if (!file) {
        return;
      }
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.id === id
            ? { ...attachment, status: "uploading", error: undefined }
            : attachment,
        ),
      );
      startUpload(id, file);
    },
    [startUpload],
  );

  const addFromPaste = useCallback(
    (event: { clipboardData: DataTransfer | null }) => {
      const clipboardFiles = event.clipboardData?.files;
      if (!clipboardFiles) {
        return;
      }
      const files = [...clipboardFiles].filter(pasteFilter);
      if (files.length > 0) {
        addFiles(files);
      }
    },
    [addFiles, pasteFilter],
  );

  const restoreReadyFiles = useCallback(
    (files: Iterable<FileAsset>) => {
      const incoming = new Map<string, FileAsset>();
      for (const file of files) {
        if (file.status === "ready" && file.workspaceId === workspaceId) {
          incoming.set(file.id, file);
        }
      }
      setAttachments((current) => {
        const unresolved = current.filter((attachment) => attachment.status !== "ready");
        const existingReady = new Map(
          current.flatMap((attachment) =>
            attachment.status === "ready" && attachment.file
              ? ([[attachment.file.id, attachment]] as const)
              : [],
          ),
        );
        const restored = [...incoming.values()].map((file): FileAttachment => {
          const existing = existingReady.get(file.id);
          return existing
            ? {
                ...existing,
                name: file.filename,
                contentType: file.contentType,
                sizeBytes: file.sizeBytes,
                status: "ready",
                file,
                error: undefined,
              }
            : {
                id: `restored:${file.id}`,
                name: file.filename,
                contentType: file.contentType,
                sizeBytes: file.sizeBytes,
                status: "ready",
                file,
                // No source File and no object URL: server metadata is the
                // only authority restored across page/device boundaries.
              };
        });
        for (const [fileId, attachment] of existingReady) {
          if (!incoming.has(fileId) && attachment.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        }
        // A server restoration is authoritative for finalized assets, but an
        // upload that has not finalized still belongs to the local actor. Keep
        // those unresolved entries while replacing the ready set exactly.
        return [...unresolved, ...restored];
      });
    },
    [workspaceId],
  );

  const remove = useCallback((id: string) => {
    sources.current.delete(id);
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    sources.current.clear();
    setAttachments((current) => {
      for (const attachment of current) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
      return [];
    });
  }, []);

  return {
    attachments,
    readyResources: attachments.flatMap((attachment): FileResourceRef[] =>
      attachment.status === "ready" && attachment.file
        ? [{ kind: "file", fileId: attachment.file.id }]
        : [],
    ),
    uploading: attachments.some((attachment) => attachment.status === "uploading"),
    addFiles,
    addFromPaste,
    restoreReadyFiles,
    retry,
    remove,
    clear,
  };
}
