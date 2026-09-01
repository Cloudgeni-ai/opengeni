import type { FileAsset, FileResourceRef } from "@opengeni/sdk";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { EmbeddedFileAttachmentClientLike } from "../client";
import { fileResourceIdentity } from "../lib/resource-identity";
import {
  useEmbeddedFileAttachments,
  type EmbeddedFileAttachmentClientOverride,
} from "../session-context";

export type UseFileAttachmentsOptions = EmbeddedFileAttachmentClientOverride & {
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
  /** Exact durable resource identity, including an optional custom mount. */
  resource?: FileResourceRef | undefined;
  /** True when this entry was reconstructed from durable resource authority. */
  restored?: boolean | undefined;
  /** Metadata hydration state for a durable reference that has no local File. */
  metadataStatus?: "loading" | "failed" | undefined;
  /** Object-URL for an inline preview; minted for `image/*` files only. */
  previewUrl?: string | undefined;
  /** Stable SDK failure code for UI behavior that must not parse error copy. */
  errorCode?: "secure_context_required" | undefined;
  /** Signed attachment-disposition URL for restored remote previews. */
  downloadUrl?: string | undefined;
  /** A local or signed image URL failed to load; render the typed icon instead. */
  previewFailed?: boolean | undefined;
  error?: string | undefined;
};

export type UseFileAttachmentsResult = {
  attachments: FileAttachment[];
  /**
   * `FileResourceRef[]` for every attachment that finished uploading — feed
   * straight into `useComposer`'s `sendExtras.resources`.
   */
  readyResources: FileResourceRef[];
  /** True while any attachment is still uploading (drives progress UI). */
  uploading: boolean;
  /**
   * True while any attachment still needs an explicit outcome: wait for an
   * upload, retry a failure, or remove it. This is the loss-prevention send
   * gate; failed cards must never be silently omitted from a message.
   */
  hasUnresolved: boolean;
  /** Explicit picker / drop path — uploads every file, no filter. */
  addFiles: (files: Iterable<File>) => void;
  /** Clipboard path — applies `pasteFilter` (default `image/*`) then uploads. */
  addFromPaste: (event: { clipboardData: DataTransfer | null }) => void;
  /**
   * Replace finalized attachments with already-revalidated server assets.
   * Optional resources preserve custom mount identities; omitted resources use
   * each file's canonical default mount.
   */
  restoreReadyFiles: (files: Iterable<FileAsset>, resources?: Iterable<FileResourceRef>) => void;
  /**
   * Reconstruct durable file references when only ResourceRef authority is
   * available. Metadata and image previews hydrate opportunistically when the
   * host exposes `getFile` / `createFileDownloadUrl`.
   */
  restoreResources?: ((resources: Iterable<FileResourceRef>) => void) | undefined;
  /**
   * Re-run the upload for a `failed` attachment, in place (same id, same
   * source file). No-op for an id that isn't a known failed upload.
   */
  retry: (id: string) => void;
  /**
   * Keep an attachment's object-URL alive for a consumer that outlives its
   * queue entry (for example, an open route-level lightbox). The returned
   * release is idempotent; pending revocation finishes after the last holder
   * releases. Returns `undefined` when the attachment has no local preview.
   */
  retainPreview: (id: string) => (() => void) | undefined;
  /** Remove one attachment; revokes its object-URL after retained users finish. */
  remove: (id: string) => void;
  /** Drop a failed preview URL while preserving the underlying attachment. */
  failPreview?: ((id: string) => void) | undefined;
  /**
   * Remove finalized attachments accepted by a send. A `FileResourceRef`
   * removes only that exact resource identity, while a legacy string durable
   * file ID removes every finalized mount of that file. Attachments added
   * while the request was in flight remain queued for the next message.
   */
  removeReadyFiles: (resources: Iterable<string | FileResourceRef>) => void;
  /** Remove all attachments and revoke every unretained object-URL. */
  clear: () => void;
};

const isImage = (file: File): boolean => file.type.startsWith("image/");

let fallbackAttachmentId = 0;

function createAttachmentId(): string {
  const cryptoSource = globalThis.crypto;
  if (typeof cryptoSource?.randomUUID === "function") return cryptoSource.randomUUID();
  fallbackAttachmentId += 1;
  // This id is only a browser-local React key and retry lookup, never durable
  // authority. Keep attachment tracking usable when HTTP withholds randomUUID
  // or Web Crypto is unavailable so the SDK's typed failure reaches the card.
  return `attachment:${Date.now().toString(36)}:${fallbackAttachmentId.toString(36)}`;
}

function secureContextRequiredErrorCode(error: unknown): "secure_context_required" | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "secure_context_required"
    ? error.code
    : undefined;
}

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
  const { client, workspaceId } = useEmbeddedFileAttachments(options);
  const pasteFilter = options.pasteFilter ?? isImage;
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const committedAttachments = useRef<FileAttachment[]>([]);
  const fileMetadata = useRef<Map<string, FileAsset>>(new Map());
  // Keep the source File per attachment id so a failed upload can be retried
  // in place. Cleared on remove/clear so it never outlives its attachment.
  const sources = useRef<Map<string, File>>(new Map());
  // Object URLs must be owned synchronously: React may discard an attachment
  // state update when its component unmounts in the same batch that minted the
  // preview. The registry remains available to cleanup even before a render.
  const previewUrls = useRef<Map<string, string>>(new Map());
  const previewRetainers = useRef<Map<string, number>>(new Map());
  const pendingPreviewRevocations = useRef<Set<string>>(new Set());
  const restoreGeneration = useRef(0);
  useLayoutEffect(() => {
    committedAttachments.current = attachments;
  }, [attachments]);
  const revokePreview = useCallback((id: string) => {
    const previewUrl = previewUrls.current.get(id);
    if (!previewUrl) return;
    if ((previewRetainers.current.get(id) ?? 0) > 0) {
      pendingPreviewRevocations.current.add(id);
      return;
    }
    previewUrls.current.delete(id);
    pendingPreviewRevocations.current.delete(id);
    URL.revokeObjectURL(previewUrl);
  }, []);
  const revokeAllPreviews = useCallback(() => {
    for (const id of previewUrls.current.keys()) revokePreview(id);
  }, [revokePreview]);
  const retainPreview = useCallback(
    (id: string): (() => void) | undefined => {
      if (!previewUrls.current.has(id)) return undefined;
      previewRetainers.current.set(id, (previewRetainers.current.get(id) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (previewRetainers.current.get(id) ?? 1) - 1;
        if (remaining > 0) {
          previewRetainers.current.set(id, remaining);
          return;
        }
        previewRetainers.current.delete(id);
        if (pendingPreviewRevocations.current.has(id)) revokePreview(id);
      };
    },
    [revokePreview],
  );
  // Ready-file reconciliation uses functional state updaters, which React may
  // evaluate during a concurrent render that later suspends or is abandoned.
  // Diff only committed attachment sets here so URL revocation cannot run from
  // render-phase code while the previously committed DOM still uses a preview.
  const committedAttachmentIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(attachments.map((attachment) => attachment.id));
    for (const id of committedAttachmentIds.current) {
      if (!currentIds.has(id)) revokePreview(id);
    }
    committedAttachmentIds.current = currentIds;
  }, [attachments, revokePreview]);
  // Upload promises are not cancellable at this layer. Fence their settlements
  // when the hook changes client/workspace or unmounts so an old tenant/session
  // cannot mutate the next attachment queue (or an already-unmounted component).
  const scopeGeneration = useRef(0);
  const previousScope = useRef({ client, workspaceId });

  useEffect(() => {
    const previous = previousScope.current;
    if (previous.client === client && previous.workspaceId === workspaceId) return;
    previousScope.current = { client, workspaceId };
    scopeGeneration.current += 1;
    restoreGeneration.current += 1;
    sources.current.clear();
    fileMetadata.current.clear();
    revokeAllPreviews();
    setAttachments([]);
  }, [client, revokeAllPreviews, workspaceId]);

  useEffect(
    () => () => {
      scopeGeneration.current += 1;
      restoreGeneration.current += 1;
      sources.current.clear();
      fileMetadata.current.clear();
      revokeAllPreviews();
    },
    [revokeAllPreviews],
  );

  // Run (or re-run) the upload for one already-tracked attachment id. Sets it
  // back to `uploading`, then resolves to `ready` (with the asset) or `failed`
  // (with the error message).
  const startUpload = useCallback(
    (id: string, file: File) => {
      const generation = scopeGeneration.current;
      void client
        .uploadFile(workspaceId, {
          filename: file.name || "file",
          contentType: file.type || "application/octet-stream",
          data: file,
        })
        .then((asset) => {
          if (scopeGeneration.current !== generation) return;
          // Retry bytes are useful only until durable finalization succeeds.
          // Drop the source File immediately; restored/ready attachments must
          // never retain browser-local byte authority.
          sources.current.delete(id);
          fileMetadata.current.set(asset.id, asset);
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id
                ? {
                    ...attachment,
                    status: "ready",
                    file: asset,
                    resource: { kind: "file", fileId: asset.id },
                    name: asset.filename,
                    contentType: asset.contentType,
                    sizeBytes: asset.sizeBytes,
                    errorCode: undefined,
                    error: undefined,
                  }
                : attachment,
            ),
          );
        })
        .catch((error: unknown) => {
          if (scopeGeneration.current !== generation) return;
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id
                ? {
                    ...attachment,
                    status: "failed",
                    errorCode: secureContextRequiredErrorCode(error),
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
        const id = createAttachmentId();
        sources.current.set(id, file);
        const previewUrl = isImage(file) ? URL.createObjectURL(file) : undefined;
        if (previewUrl) previewUrls.current.set(id, previewUrl);
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
            ? { ...attachment, status: "uploading", errorCode: undefined, error: undefined }
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
    (files: Iterable<FileAsset>, resources?: Iterable<FileResourceRef>) => {
      const incomingFiles = new Map<string, FileAsset>();
      for (const file of files) {
        if (file.status === "ready" && file.workspaceId === workspaceId) {
          incomingFiles.set(file.id, file);
        }
      }
      const incomingResources = resources
        ? dedupeFileResources(resources).filter((resource) => incomingFiles.has(resource.fileId))
        : [...incomingFiles.keys()].map((fileId): FileResourceRef => ({ kind: "file", fileId }));
      for (const file of incomingFiles.values()) fileMetadata.current.set(file.id, file);
      const existingReady = new Map(
        committedAttachments.current.flatMap((attachment) =>
          attachment.status === "ready" && attachment.resource
            ? ([[fileResourceIdentity(attachment.resource), attachment]] as const)
            : [],
        ),
      );
      const generation = ++restoreGeneration.current;
      setAttachments((current) => {
        const unresolved = current.filter((attachment) => attachment.status !== "ready");
        const currentReady = new Map(
          current.flatMap((attachment) =>
            attachment.status === "ready" && attachment.resource
              ? ([[fileResourceIdentity(attachment.resource), attachment]] as const)
              : [],
          ),
        );
        const restored = incomingResources.map((resource): FileAttachment => {
          const file = incomingFiles.get(resource.fileId)!;
          const existing = currentReady.get(fileResourceIdentity(resource));
          return existing
            ? {
                ...existing,
                name: file.filename,
                contentType: file.contentType,
                sizeBytes: file.sizeBytes,
                status: "ready",
                file,
                errorCode: undefined,
                resource,
                error: undefined,
                metadataStatus: undefined,
              }
            : {
                id: restoredAttachmentId(resource),
                name: file.filename,
                contentType: file.contentType,
                sizeBytes: file.sizeBytes,
                status: "ready",
                file,
                resource,
                restored: true,
                // No source File and no object URL: server metadata is the
                // only authority restored across page/device boundaries.
              };
        });
        // A server restoration is authoritative for finalized assets, but an
        // upload that has not finalized still belongs to the local actor. Keep
        // those unresolved entries while replacing the ready set exactly.
        return [...unresolved, ...restored];
      });
      const resourcesByFile = groupPreviewResources(
        incomingResources.filter((resource) => {
          const existing = existingReady.get(fileResourceIdentity(resource));
          return (
            !existing ||
            (existing.restored === true && !existing.previewUrl && !existing.previewFailed)
          );
        }),
      );
      for (const [fileId, previewResources] of resourcesByFile) {
        hydrateRemotePreview({
          client,
          workspaceId,
          file: incomingFiles.get(fileId)!,
          resources: previewResources,
          generation,
          restoreGeneration,
          setAttachments,
        });
      }
    },
    [client, workspaceId],
  );

  const restoreResources = useCallback(
    (resources: Iterable<FileResourceRef>) => {
      const getFile = optionalGetFile(client);
      const incoming = dedupeFileResources(resources);
      const incomingKeys = new Set(incoming.map(fileResourceIdentity));
      const snapshot = committedAttachments.current;
      const localKeys = new Set(
        snapshot.flatMap((attachment) =>
          attachment.restored !== true && attachment.resource
            ? [fileResourceIdentity(attachment.resource)]
            : [],
        ),
      );
      const generation = ++restoreGeneration.current;
      setAttachments((current) => {
        const existingByKey = new Map(
          current.flatMap((attachment) =>
            attachment.resource
              ? ([[fileResourceIdentity(attachment.resource), attachment]] as const)
              : [],
          ),
        );
        const local = current.filter((attachment) => attachment.restored !== true);
        const currentLocalKeys = new Set(
          local.flatMap((attachment) =>
            attachment.resource ? [fileResourceIdentity(attachment.resource)] : [],
          ),
        );
        const restored = incoming.flatMap((resource): FileAttachment[] => {
          const key = fileResourceIdentity(resource);
          if (currentLocalKeys.has(key)) return [];
          const existing = existingByKey.get(key);
          const file = existing?.file ?? fileMetadata.current.get(resource.fileId);
          if (file) {
            return [
              {
                ...existing,
                id: existing?.id ?? restoredAttachmentId(resource),
                name: file.filename,
                contentType: file.contentType,
                sizeBytes: file.sizeBytes,
                status: "ready",
                file,
                resource,
                restored: true,
                metadataStatus: undefined,
              },
            ];
          }
          return [
            existing
              ? { ...existing, resource, restored: true, metadataStatus: "loading" }
              : {
                  id: restoredAttachmentId(resource),
                  name: resource.fileId,
                  contentType: "application/octet-stream",
                  sizeBytes: 0,
                  status: "ready",
                  resource,
                  restored: true,
                  metadataStatus: "loading",
                },
          ];
        });
        return [
          ...local,
          ...restored.filter((attachment) =>
            attachment.resource
              ? incomingKeys.has(fileResourceIdentity(attachment.resource))
              : false,
          ),
        ];
      });

      const missingFileIds = [
        ...new Set(
          incoming
            .filter(
              (resource) =>
                !localKeys.has(fileResourceIdentity(resource)) &&
                !fileMetadata.current.has(resource.fileId),
            )
            .map((resource) => resource.fileId),
        ),
      ];
      hydrateCachedPreviews({
        client,
        workspaceId,
        resources: incoming.filter(
          (resource) =>
            !localKeys.has(fileResourceIdentity(resource)) &&
            fileMetadata.current.has(resource.fileId) &&
            !snapshot.some(
              (attachment) =>
                attachment.resource &&
                fileResourceIdentity(attachment.resource) === fileResourceIdentity(resource) &&
                (attachment.previewUrl !== undefined || attachment.previewFailed === true),
            ),
        ),
        fileMetadata: fileMetadata.current,
        generation,
        restoreGeneration,
        setAttachments,
      });

      if (!getFile || missingFileIds.length === 0) {
        if (!getFile && missingFileIds.length > 0) {
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.restored === true &&
              attachment.metadataStatus === "loading" &&
              missingFileIds.includes(attachment.resource?.fileId ?? "")
                ? { ...attachment, metadataStatus: "failed" }
                : attachment,
            ),
          );
        }
        return;
      }
      void Promise.allSettled(missingFileIds.map((fileId) => getFile(workspaceId, fileId))).then(
        (settled) => {
          if (restoreGeneration.current !== generation) return;
          const hydrated = new Map<string, FileAsset>();
          const failed = new Set<string>();
          settled.forEach((result, index) => {
            const fileId = missingFileIds[index];
            if (!fileId) return;
            if (
              result.status === "fulfilled" &&
              result.value.id === fileId &&
              result.value.workspaceId === workspaceId &&
              result.value.status === "ready"
            ) {
              hydrated.set(fileId, result.value);
              fileMetadata.current.set(fileId, result.value);
            } else {
              failed.add(fileId);
            }
          });
          setAttachments((current) =>
            current.map((attachment) => {
              if (attachment.restored !== true || !attachment.resource) return attachment;
              const file = hydrated.get(attachment.resource.fileId);
              if (file) {
                return {
                  ...attachment,
                  name: file.filename,
                  contentType: file.contentType,
                  sizeBytes: file.sizeBytes,
                  file,
                  metadataStatus: undefined,
                  error: undefined,
                };
              }
              return failed.has(attachment.resource.fileId)
                ? { ...attachment, metadataStatus: "failed" }
                : attachment;
            }),
          );
          hydrateCachedPreviews({
            client,
            workspaceId,
            resources: incoming.filter((resource) => hydrated.has(resource.fileId)),
            fileMetadata: hydrated,
            generation,
            restoreGeneration,
            setAttachments,
          });
        },
      );
    },
    [client, workspaceId],
  );

  const remove = useCallback(
    (id: string) => {
      sources.current.delete(id);
      revokePreview(id);
      setAttachments((current) => current.filter((attachment) => attachment.id !== id));
    },
    [revokePreview],
  );

  const failPreview = useCallback(
    (id: string) => {
      revokePreview(id);
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.id === id
            ? { ...attachment, previewUrl: undefined, previewFailed: true }
            : attachment,
        ),
      );
    },
    [revokePreview],
  );

  const removeReadyFiles = useCallback((resources: Iterable<string | FileResourceRef>) => {
    const acceptedFileIds = new Set<string>();
    const acceptedResourceKeys = new Set<string>();
    for (const resource of resources) {
      if (typeof resource === "string") acceptedFileIds.add(resource);
      else acceptedResourceKeys.add(fileResourceIdentity(resource));
    }
    if (acceptedFileIds.size === 0 && acceptedResourceKeys.size === 0) return;
    setAttachments((current) =>
      current.filter((attachment) => {
        if (attachment.status !== "ready" || !attachment.resource) return true;
        return !(
          acceptedFileIds.has(attachment.resource.fileId) ||
          acceptedResourceKeys.has(fileResourceIdentity(attachment.resource))
        );
      }),
    );
  }, []);

  const clear = useCallback(() => {
    sources.current.clear();
    revokeAllPreviews();
    setAttachments([]);
  }, [revokeAllPreviews]);

  return {
    attachments,
    readyResources: attachments.flatMap((attachment): FileResourceRef[] =>
      attachment.status === "ready" && attachment.resource ? [attachment.resource] : [],
    ),
    uploading: attachments.some((attachment) => attachment.status === "uploading"),
    hasUnresolved: attachments.some((attachment) => attachment.status !== "ready"),
    addFiles,
    addFromPaste,
    restoreReadyFiles,
    restoreResources,
    retry,
    retainPreview,
    remove,
    failPreview,
    removeReadyFiles,
    clear,
  };
}

function dedupeFileResources(resources: Iterable<FileResourceRef>): FileResourceRef[] {
  const seen = new Set<string>();
  return [...resources].filter((resource) => {
    const key = fileResourceIdentity(resource);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function restoredAttachmentId(resource: FileResourceRef): string {
  return `restored:${fileResourceIdentity(resource)}`;
}

function groupPreviewResources(
  resources: Iterable<FileResourceRef>,
): Map<string, FileResourceRef[]> {
  const grouped = new Map<string, FileResourceRef[]>();
  for (const resource of resources) {
    const current = grouped.get(resource.fileId) ?? [];
    current.push(resource);
    grouped.set(resource.fileId, current);
  }
  return grouped;
}

function hydrateCachedPreviews({
  client,
  workspaceId,
  resources,
  fileMetadata,
  generation,
  restoreGeneration,
  setAttachments,
}: {
  client: EmbeddedFileAttachmentClientLike;
  workspaceId: string;
  resources: Iterable<FileResourceRef>;
  fileMetadata: ReadonlyMap<string, FileAsset>;
  generation: number;
  restoreGeneration: { current: number };
  setAttachments: Dispatch<SetStateAction<FileAttachment[]>>;
}): void {
  for (const [fileId, previewResources] of groupPreviewResources(resources)) {
    const file = fileMetadata.get(fileId);
    if (!file) continue;
    hydrateRemotePreview({
      client,
      workspaceId,
      file,
      resources: previewResources,
      generation,
      restoreGeneration,
      setAttachments,
    });
  }
}

function hydrateRemotePreview({
  client,
  workspaceId,
  file,
  resources,
  generation,
  restoreGeneration,
  setAttachments,
}: {
  client: EmbeddedFileAttachmentClientLike;
  workspaceId: string;
  file: FileAsset;
  resources: FileResourceRef[];
  generation: number;
  restoreGeneration: { current: number };
  setAttachments: Dispatch<SetStateAction<FileAttachment[]>>;
}): void {
  const createFileDownloadUrl = optionalCreateFileDownloadUrl(client);
  if (!file.contentType.startsWith("image/") || !createFileDownloadUrl) return;
  const keys = new Set(resources.map(fileResourceIdentity));
  void createFileDownloadUrl(workspaceId, file.id)
    .then((signed) => {
      if (restoreGeneration.current !== generation) return;
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.restored === true &&
          attachment.resource &&
          keys.has(fileResourceIdentity(attachment.resource))
            ? { ...attachment, previewUrl: signed.url, previewFailed: undefined }
            : attachment,
        ),
      );
    })
    .catch(() => {
      if (restoreGeneration.current !== generation) return;
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.restored === true &&
          attachment.resource &&
          keys.has(fileResourceIdentity(attachment.resource))
            ? { ...attachment, previewFailed: true }
            : attachment,
        ),
      );
    });
  void createFileDownloadUrl(workspaceId, file.id, { disposition: "attachment" })
    .then((signed) => {
      if (restoreGeneration.current !== generation) return;
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.restored === true &&
          attachment.resource &&
          keys.has(fileResourceIdentity(attachment.resource))
            ? { ...attachment, downloadUrl: signed.url }
            : attachment,
        ),
      );
    })
    .catch(() => undefined);
}

function optionalGetFile(
  client: EmbeddedFileAttachmentClientLike,
): NonNullable<EmbeddedFileAttachmentClientLike["getFile"]> | undefined {
  if (!("getFile" in client) || typeof client.getFile !== "function") return undefined;
  return client.getFile.bind(client);
}

function optionalCreateFileDownloadUrl(
  client: EmbeddedFileAttachmentClientLike,
): NonNullable<EmbeddedFileAttachmentClientLike["createFileDownloadUrl"]> | undefined {
  if (!("createFileDownloadUrl" in client) || typeof client.createFileDownloadUrl !== "function") {
    return undefined;
  }
  return client.createFileDownloadUrl.bind(client);
}
