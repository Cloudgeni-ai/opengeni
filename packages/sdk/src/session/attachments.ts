import type { FileAsset, FileResourceRef, FileUploadData } from "../types";
import type { FileAttachmentClientLike } from "./client";
import type { SessionRuntimeEnvironment } from "./environment";
import { defaultSessionRuntimeEnvironment } from "./environment";
import {
  createExternalStore,
  type OpenGeniExternalStore,
  type OpenGeniStoreDiagnostics,
} from "./store";

export type SessionAttachmentSource = Readonly<{
  name?: string | undefined;
  type?: string | undefined;
  size?: number | undefined;
  data: FileUploadData;
}>;

export type FileAttachment = Readonly<{
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  status: "uploading" | "ready" | "failed";
  file?: FileAsset | undefined;
  previewUrl?: string | undefined;
  error?: string | undefined;
}>;

export type FileAttachmentStoreSnapshot = Readonly<{
  attachments: readonly FileAttachment[];
  readyResources: readonly FileResourceRef[];
  uploading: boolean;
  hasUnresolved: boolean;
}>;

export type FileAttachmentStore = OpenGeniExternalStore<FileAttachmentStoreSnapshot> & {
  addFiles(files: Iterable<SessionAttachmentSource | File>): void;
  restoreReadyFiles(files: Iterable<FileAsset>): void;
  retry(id: string): void;
  retainPreview(id: string): (() => void) | undefined;
  remove(id: string): void;
  removeReadyFiles(fileIds: Iterable<string>): void;
  clear(): void;
  diagnostics(): OpenGeniStoreDiagnostics;
};

const EMPTY_SNAPSHOT: FileAttachmentStoreSnapshot = Object.freeze({
  attachments: Object.freeze([]),
  readyResources: Object.freeze([]),
  uploading: false,
  hasUnresolved: false,
});

export function createFileAttachmentStore(options: {
  client: FileAttachmentClientLike;
  workspaceId: string;
  environment?: SessionRuntimeEnvironment;
}): FileAttachmentStore {
  const environment = options.environment ?? defaultSessionRuntimeEnvironment();
  let generation = 0;
  const sources = new Map<string, SessionAttachmentSource>();
  const previewUrls = new Map<string, string>();
  const previewRetainers = new Map<string, number>();
  const pendingPreviewRevocations = new Set<string>();
  const store = createExternalStore<FileAttachmentStoreSnapshot>({
    initialSnapshot: EMPTY_SNAPSHOT,
    destroy: () => {
      generation += 1;
      sources.clear();
      revokeAllPreviews();
    },
  });

  const publishAttachments = (attachments: readonly FileAttachment[]) => {
    const frozen = Object.freeze([...attachments]);
    store.publish(
      Object.freeze({
        attachments: frozen,
        readyResources: Object.freeze(
          frozen.flatMap((attachment): FileResourceRef[] =>
            attachment.status === "ready" && attachment.file
              ? [{ kind: "file", fileId: attachment.file.id }]
              : [],
          ),
        ),
        uploading: frozen.some((attachment) => attachment.status === "uploading"),
        hasUnresolved: frozen.some((attachment) => attachment.status !== "ready"),
      }),
    );
  };

  const updateAttachment = (id: string, update: (current: FileAttachment) => FileAttachment) => {
    publishAttachments(
      store
        .getSnapshot()
        .attachments.map((attachment) => (attachment.id === id ? update(attachment) : attachment)),
    );
  };

  const revokePreview = (id: string) => {
    const url = previewUrls.get(id);
    if (!url) return;
    if ((previewRetainers.get(id) ?? 0) > 0) {
      pendingPreviewRevocations.add(id);
      return;
    }
    previewUrls.delete(id);
    pendingPreviewRevocations.delete(id);
    environment.objectUrls?.revoke(url);
    store.trackObjectUrl(-1);
  };

  function revokeAllPreviews() {
    for (const id of [...previewUrls.keys()]) revokePreview(id);
  }

  const startUpload = (id: string, source: SessionAttachmentSource) => {
    const ownedGeneration = generation;
    void store.trackRead(async () => {
      try {
        const asset = await options.client.uploadFile(options.workspaceId, {
          filename: source.name || "file",
          contentType: source.type || "application/octet-stream",
          data: source.data,
        });
        if (store.signal.aborted || generation !== ownedGeneration || !sources.has(id)) return;
        sources.delete(id);
        updateAttachment(id, (attachment) => ({
          ...attachment,
          status: "ready",
          file: asset,
          name: asset.filename,
          contentType: asset.contentType,
          sizeBytes: asset.sizeBytes,
          error: undefined,
        }));
      } catch (cause) {
        if (store.signal.aborted || generation !== ownedGeneration || !sources.has(id)) return;
        updateAttachment(id, (attachment) => ({
          ...attachment,
          status: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      }
    });
  };

  return Object.assign(store, {
    addFiles(files: Iterable<SessionAttachmentSource | File>) {
      for (const input of files) {
        if (store.signal.aborted) return;
        const source = normalizeSource(input);
        const id = environment.ids.randomUUID();
        sources.set(id, source);
        let previewUrl: string | undefined;
        if (
          source.type?.startsWith("image/") &&
          environment.objectUrls &&
          source.data instanceof Blob
        ) {
          previewUrl = environment.objectUrls.create(source.data);
          previewUrls.set(id, previewUrl);
          store.trackObjectUrl(1);
        }
        publishAttachments([
          ...store.getSnapshot().attachments,
          {
            id,
            name: source.name || (source.type?.startsWith("image/") ? "image" : "file"),
            contentType: source.type || "application/octet-stream",
            sizeBytes: source.size ?? uploadDataSize(source.data),
            status: "uploading",
            ...(previewUrl ? { previewUrl } : {}),
          },
        ]);
        startUpload(id, source);
      }
    },
    restoreReadyFiles(files: Iterable<FileAsset>) {
      const incoming = new Map<string, FileAsset>();
      for (const file of files) {
        if (file.status === "ready" && file.workspaceId === options.workspaceId) {
          incoming.set(file.id, file);
        }
      }
      const current = store.getSnapshot().attachments;
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
            };
      });
      const retainedIds = new Set([...unresolved, ...restored].map((attachment) => attachment.id));
      publishAttachments([...unresolved, ...restored]);
      for (const attachment of current) {
        if (!retainedIds.has(attachment.id)) revokePreview(attachment.id);
      }
    },
    retry(id: string) {
      const source = sources.get(id);
      const attachment = store.getSnapshot().attachments.find((candidate) => candidate.id === id);
      if (!source || attachment?.status !== "failed" || store.signal.aborted) return;
      updateAttachment(id, (current) => ({ ...current, status: "uploading", error: undefined }));
      startUpload(id, source);
    },
    retainPreview(id: string) {
      if (!previewUrls.has(id)) return undefined;
      previewRetainers.set(id, (previewRetainers.get(id) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (previewRetainers.get(id) ?? 1) - 1;
        if (remaining > 0) {
          previewRetainers.set(id, remaining);
          return;
        }
        previewRetainers.delete(id);
        if (pendingPreviewRevocations.has(id)) revokePreview(id);
      };
    },
    remove(id: string) {
      sources.delete(id);
      publishAttachments(
        store.getSnapshot().attachments.filter((attachment) => attachment.id !== id),
      );
      revokePreview(id);
    },
    removeReadyFiles(fileIds: Iterable<string>) {
      const accepted = new Set(fileIds);
      if (accepted.size === 0) return;
      const current = store.getSnapshot().attachments;
      const removedIds = current.flatMap((attachment) =>
        attachment.status === "ready" &&
        attachment.file !== undefined &&
        accepted.has(attachment.file.id)
          ? [attachment.id]
          : [],
      );
      if (removedIds.length === 0) return;
      const removed = new Set(removedIds);
      publishAttachments(current.filter((attachment) => !removed.has(attachment.id)));
      for (const id of removed) revokePreview(id);
    },
    clear() {
      sources.clear();
      publishAttachments([]);
      revokeAllPreviews();
    },
    diagnostics: store.diagnostics,
  });
}

function normalizeSource(input: SessionAttachmentSource | File): SessionAttachmentSource {
  if ("data" in input) return input;
  return { name: input.name, type: input.type, size: input.size, data: input };
}

function uploadDataSize(data: FileUploadData): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof Blob) return data.size;
  return data.byteLength;
}
