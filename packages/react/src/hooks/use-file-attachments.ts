import type { FileAsset, FileResourceRef } from "@opengeni/sdk";
import { useCallback, useState } from "react";
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
export function useFileAttachments(options: UseFileAttachmentsOptions = {}): UseFileAttachmentsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const pasteFilter = options.pasteFilter ?? isImage;
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);

  const addFiles = useCallback((files: Iterable<File>) => {
    for (const file of files) {
      const id = crypto.randomUUID();
      const previewUrl = isImage(file) ? URL.createObjectURL(file) : undefined;
      setAttachments((current) => [...current, {
        id,
        name: file.name || "image",
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        status: "uploading",
        ...(previewUrl ? { previewUrl } : {}),
      }]);
      void client.uploadFile(workspaceId, {
        filename: file.name || "file",
        contentType: file.type || "application/octet-stream",
        data: file,
      }).then((asset) => {
        setAttachments((current) => current.map((attachment) => attachment.id === id
          ? { ...attachment, status: "ready", file: asset, name: asset.filename, contentType: asset.contentType, sizeBytes: asset.sizeBytes }
          : attachment));
      }).catch((error: unknown) => {
        setAttachments((current) => current.map((attachment) => attachment.id === id
          ? { ...attachment, status: "failed", error: error instanceof Error ? error.message : String(error) }
          : attachment));
      });
    }
  }, [client, workspaceId]);

  const addFromPaste = useCallback((event: { clipboardData: DataTransfer | null }) => {
    const clipboardFiles = event.clipboardData?.files;
    if (!clipboardFiles) {
      return;
    }
    const files = [...clipboardFiles].filter(pasteFilter);
    if (files.length > 0) {
      addFiles(files);
    }
  }, [addFiles, pasteFilter]);

  const remove = useCallback((id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
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
    readyResources: attachments.flatMap((attachment): FileResourceRef[] => attachment.status === "ready" && attachment.file
      ? [{ kind: "file", fileId: attachment.file.id }]
      : []),
    uploading: attachments.some((attachment) => attachment.status === "uploading"),
    addFiles,
    addFromPaste,
    remove,
    clear,
  };
}
