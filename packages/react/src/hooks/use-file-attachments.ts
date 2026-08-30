import {
  createFileAttachmentStore,
  type FileAttachment as SessionFileAttachment,
} from "@opengeni/sdk/session";
import type { FileAsset, FileResourceRef } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  useEmbeddedFileAttachments,
  type EmbeddedFileAttachmentClientOverride,
} from "../session-context";
import { useOwnedExternalStore } from "./internal";

export type UseFileAttachmentsOptions = EmbeddedFileAttachmentClientOverride & {
  /** Clipboard-only admission policy. Explicit picker/drop additions bypass it. */
  pasteFilter?: ((file: File) => boolean) | undefined;
};

export type FileAttachment = SessionFileAttachment;

export type UseFileAttachmentsResult = {
  attachments: FileAttachment[];
  readyResources: FileResourceRef[];
  uploading: boolean;
  hasUnresolved: boolean;
  addFiles: (files: Iterable<File>) => void;
  addFromPaste: (event: { clipboardData: DataTransfer | null }) => void;
  restoreReadyFiles: (files: Iterable<FileAsset>) => void;
  retry: (id: string) => void;
  retainPreview: (id: string) => (() => void) | undefined;
  remove: (id: string) => void;
  removeReadyFiles: (fileIds: Iterable<string>) => void;
  clear: () => void;
};

const isImage = (file: File): boolean => file.type.startsWith("image/");

/** React adapter over the framework-neutral attachment controller. */
export function useFileAttachments(
  options: UseFileAttachmentsOptions = {},
): UseFileAttachmentsResult {
  const { client, workspaceId } = useEmbeddedFileAttachments(options);
  const pasteFilter = options.pasteFilter ?? isImage;
  const store = useMemo(
    () => createFileAttachmentStore({ client, workspaceId }),
    [client, workspaceId],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const releaseCommittedPreviews = useCommittedPreviewLeases(store, snapshot.attachments);
  const retireResources = useCallback(() => {
    releaseCommittedPreviews();
    store.clear();
  }, [releaseCommittedPreviews, store]);
  useOwnedExternalStore(store, retireResources);
  const addFiles = useCallback(
    (files: Iterable<File>) => {
      store.addFiles(files);
    },
    [store],
  );
  const addFromPaste = useCallback(
    (event: { clipboardData: DataTransfer | null }) => {
      const files = event.clipboardData?.files;
      if (!files) return;
      const accepted = [...files].filter(pasteFilter);
      if (accepted.length > 0) store.addFiles(accepted);
    },
    [pasteFilter, store],
  );

  return {
    attachments: [...snapshot.attachments],
    readyResources: [...snapshot.readyResources],
    uploading: snapshot.uploading,
    hasUnresolved: snapshot.hasUnresolved,
    addFiles,
    addFromPaste,
    restoreReadyFiles: store.restoreReadyFiles,
    retry: store.retry,
    retainPreview: store.retainPreview,
    remove: store.remove,
    removeReadyFiles: store.removeReadyFiles,
    clear: store.clear,
  };
}

function useCommittedPreviewLeases(
  store: {
    retainPreview(id: string): (() => void) | undefined;
  },
  attachments: readonly FileAttachment[],
): () => void {
  const leasesByStore = useRef(new Map<object, Map<string, () => void>>());
  useEffect(() => {
    let leases = leasesByStore.current.get(store);
    if (!leases) {
      leases = new Map();
      leasesByStore.current.set(store, leases);
    }
    const committed = new Set(
      attachments.flatMap((attachment) => (attachment.previewUrl ? [attachment.id] : [])),
    );
    for (const id of committed) {
      if (leases.has(id)) continue;
      const release = store.retainPreview(id);
      if (release) leases.set(id, release);
    }
    for (const [id, release] of [...leases]) {
      if (committed.has(id)) continue;
      leases.delete(id);
      release();
    }
  }, [attachments, store]);

  return useCallback(() => {
    const leases = leasesByStore.current.get(store);
    if (!leases) return;
    leasesByStore.current.delete(store);
    for (const release of leases.values()) release();
  }, [store]);
}
