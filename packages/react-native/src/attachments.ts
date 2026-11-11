import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileAsset, ResourceRef, SendMessageInput, UploadFileInput } from "@opengeni/sdk";
import type { FileAttachmentClientLike, StoredFileSource } from "@opengeni/react/session";
import type { NativeCryptoAdapter, NativeFileAdapter, NativePickedFile } from "./adapters";
import { useOpenGeniText, type OpenGeniText } from "@opengeni/react/messages";
import { errorMessage } from "@opengeni/contracts/values";

export type NativeAttachmentStatus = "preparing" | "uploading" | "ready" | "failed";

export const NATIVE_ATTACHMENT_PREPARATION_TIMEOUT_MS = 30_000;

/**
 * The largest streamed file the device hashes before uploading. It matches the
 * server's limit for files shown to the model inline, the only ones that need a
 * digest pinned at upload; larger files (long videos) upload unhashed, as a
 * plain REST upload does, so they never have to be read into memory.
 */
export const NATIVE_ATTACHMENT_DIGEST_MAX_BYTES = 20 * 1024 * 1024;

/** How a file shows in the composer: a photo, a video or a named document. */
export function nativeAttachmentKind(contentType: string): NativePickedFile["kind"] {
  const type = contentType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return "document";
}

export interface NativeAttachment {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number | null;
  kind: NativePickedFile["kind"];
  previewUri?: string | undefined;
  /** Length of a video, when known. */
  durationSeconds?: number | undefined;
  status: NativeAttachmentStatus;
  /** Fraction of the bytes sent (0 to 1) while a streamed upload is in flight. */
  progress?: number | undefined;
  file?: FileAsset | undefined;
  error?: string | undefined;
}

export interface NativeFileAttachmentsResult {
  attachments: NativeAttachment[];
  readyResources: ResourceRef[];
  uploading: boolean;
  hasUnresolved: boolean;
  error: Error | null;
  pickDocuments(): Promise<void>;
  pickImages(): Promise<void>;
  /** Take a photo with the camera and attach it. Absent when the host's adapter has no camera. */
  takePhoto?: (() => Promise<void>) | undefined;
  addFiles(files: NativePickedFile[]): Promise<void>;
  retry(id: string): Promise<void>;
  remove(id: string): void;
  /**
   * Remove only ready files whose durable ids a send captured. Files added
   * while that send was in flight stay queued for the next message.
   */
  removeReadyFiles(fileIds: Iterable<string>): void;
  clear(): void;
  clearError(): void;
  /** Show already-uploaded files (a restored draft) as ready attachments. */
  restoreReady(files: Iterable<FileAsset>): void;
  /** Where this chat's stored files are read from, so attached images show their picture. */
  fileSource: StoredFileSource;
}

export interface NativeAttachmentScope {
  client: FileAttachmentClientLike;
  workspaceId: string;
  sessionId: string;
}

export function sameNativeAttachmentScope(
  left: NativeAttachmentScope,
  right: NativeAttachmentScope,
): boolean {
  return (
    left.client === right.client &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId
  );
}

export function projectNativeAttachmentScopeState(
  scopeMatches: boolean,
  attachments: NativeAttachment[],
  error: Error | null,
): { attachments: NativeAttachment[]; error: Error | null } {
  return scopeMatches ? { attachments, error } : { attachments: [], error: null };
}

/** Drop the ready attachments whose durable file ids are in `fileIds`. */
export function removeReadyNativeAttachments(
  current: NativeAttachment[],
  fileIds: Iterable<string>,
): NativeAttachment[] {
  const sent = new Set(fileIds);
  if (sent.size === 0) return current;
  const kept = current.filter(
    (entry) => !(entry.status === "ready" && entry.file && sent.has(entry.file.id)),
  );
  return kept.length === current.length ? current : kept;
}

function sentFileIds(input: SendMessageInput): string[] {
  return (input.resources ?? []).flatMap((resource) =>
    resource.kind === "file" ? [resource.fileId] : [],
  );
}

/**
 * Composer callbacks that keep the attachment tray in step with sends. An
 * ordinary Send is acknowledged locally (`onSubmitted`), so its files leave
 * the tray at once; waiting for server acceptance left them visible and a
 * second tap re-sent the same files as a file-only message. Steer and
 * recovered sends only report acceptance (`onSent`). Both remove exactly the
 * files that send captured.
 */
export function nativeComposerAttachmentCallbacks(
  attachments: Pick<NativeFileAttachmentsResult, "removeReadyFiles">,
): {
  onSubmitted: (text: string, input: SendMessageInput) => void;
  onSent: (text: string, input: SendMessageInput) => void;
} {
  const removeSent = (_text: string, input: SendMessageInput) =>
    attachments.removeReadyFiles(sentFileIds(input));
  return { onSubmitted: removeSent, onSent: removeSent };
}

export async function runNativeAttachmentPicker(input: {
  generation: number;
  currentGeneration(): number;
  pick(): Promise<NativePickedFile[]>;
  addFiles(files: NativePickedFile[], generation: number): Promise<void>;
  onError(error: Error): void;
}): Promise<"added" | "failed" | "stale"> {
  try {
    const files = await input.pick();
    if (input.currentGeneration() !== input.generation) return "stale";
    await input.addFiles(files, input.generation);
    return input.currentGeneration() === input.generation ? "added" : "stale";
  } catch (cause) {
    if (input.currentGeneration() !== input.generation) return "stale";
    input.onError(cause instanceof Error ? cause : new Error(String(cause)));
    return "failed";
  }
}

export async function addNativeFilesForGeneration(input: {
  files: NativePickedFile[];
  generation: number;
  currentGeneration(): number;
  hasSource(id: string): boolean;
  rememberSource(file: NativePickedFile): void;
  appendAttachments(files: NativePickedFile[]): void;
  upload(file: NativePickedFile, generation: number): Promise<void>;
}): Promise<void> {
  if (input.currentGeneration() !== input.generation) return;
  const unique = input.files.filter((file) => !input.hasSource(file.id));
  if (unique.length === 0) return;
  for (const file of unique) input.rememberSource(file);
  input.appendAttachments(unique);
  await unique.reduce(async (previous, file) => {
    await previous;
    if (input.currentGeneration() !== input.generation) return;
    await input.upload(file, input.generation);
  }, Promise.resolve());
}

/** Read a picked file and hash it, each step bounded so a stuck read fails retryably. */
async function digestNativeAttachment(
  t: OpenGeniText,
  input: {
    source: NativePickedFile;
    files: NativeFileAdapter;
    crypto: NativeCryptoAdapter;
    timeoutMs?: number | undefined;
  },
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const timeoutMs = input.timeoutMs ?? NATIVE_ATTACHMENT_PREPARATION_TIMEOUT_MS;
  const bytes = await withTimeout(
    input.files.readBytes(input.source),
    timeoutMs,
    t("native.attachments.filePreparationTimedOutRetry"),
  );
  const sha256 = await withTimeout(
    input.crypto.sha256Hex(bytes),
    timeoutMs,
    t("native.attachments.fileVerificationTimedOutRetry"),
  );
  return { bytes, sha256 };
}

export async function prepareNativeAttachmentUpload(
  t: OpenGeniText,
  input: {
    source: NativePickedFile;
    files: NativeFileAdapter;
    crypto: NativeCryptoAdapter;
    timeoutMs?: number | undefined;
  },
): Promise<{ bytes: Uint8Array; data: ArrayBuffer; sha256: string }> {
  const { bytes, sha256 } = await digestNativeAttachment(t, input);
  // The Opengeni SDK accepts either Uint8Array or ArrayBuffer, but its
  // Uint8Array snapshot uses `new Blob([view])`. React Native's Blob rejects
  // ArrayBufferView inputs, so pass an exact ArrayBuffer and avoid that branch.
  const uploadBytes = Uint8Array.from(bytes);
  const data = uploadBytes.buffer;
  return { bytes, data, sha256 };
}

/**
 * The upload input for a picked file. With a streaming adapter the device
 * sends the file from disk (reporting progress) and hashes only files up to
 * {@link NATIVE_ATTACHMENT_DIGEST_MAX_BYTES}; without one the file is read
 * into memory and hashed, as before.
 */
export async function prepareNativeAttachmentData(
  t: OpenGeniText,
  input: {
    source: NativePickedFile;
    files: NativeFileAdapter;
    crypto: NativeCryptoAdapter;
    onProgress: (fraction: number) => void;
    timeoutMs?: number | undefined;
  },
): Promise<{ data: UploadFileInput["data"]; sha256?: string | undefined; streamed: boolean }> {
  const streamed = input.files.uploadSource?.(input.source, input.onProgress);
  if (!streamed) {
    const { data, sha256 } = await prepareNativeAttachmentUpload(t, input);
    return { data, sha256, streamed: false };
  }
  if (streamed.sizeBytes > NATIVE_ATTACHMENT_DIGEST_MAX_BYTES) {
    return { data: streamed, streamed: true };
  }
  const { sha256 } = await digestNativeAttachment(t, input);
  return { data: streamed, sha256, streamed: true };
}

/** Stop one upload in flight, or all of them. */
function cancelTransfers(transfers: Map<string, AbortController>, id?: string): void {
  for (const [key, controller] of transfers) {
    if (id !== undefined && key !== id) continue;
    controller.abort();
    transfers.delete(key);
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Native attachment timeout must be a positive number");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function useNativeFileAttachments(input: {
  client: FileAttachmentClientLike;
  workspaceId: string;
  sessionId: string;
  /** `personal` keeps uploads Only me; omitted, the server (or a session proxy) decides. */
  scope?: "workspace" | "personal" | undefined;
  files: NativeFileAdapter;
  crypto: NativeCryptoAdapter;
}): NativeFileAttachmentsResult {
  const t = useOpenGeniText();
  const [attachments, setAttachments] = useState<NativeAttachment[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const sources = useRef(new Map<string, NativePickedFile>());
  const attempts = useRef(new Map<string, number>());
  // One per upload in flight: removing a file (or leaving the chat) stops its
  // transfer, so a long video does not keep sending in the background.
  const transfers = useRef(new Map<string, AbortController>());
  const scopeGeneration = useRef(0);
  const currentScope = {
    client: input.client,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  } satisfies NativeAttachmentScope;
  const previousScope = useRef(currentScope);
  const scopeMatches = sameNativeAttachmentScope(previousScope.current, currentScope);

  useLayoutEffect(() => {
    const nextScope = {
      client: input.client,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    };
    if (sameNativeAttachmentScope(previousScope.current, nextScope)) return;
    previousScope.current = nextScope;
    scopeGeneration.current += 1;
    cancelTransfers(transfers.current);
    sources.current.clear();
    attempts.current.clear();
    setAttachments([]);
    setError(null);
  }, [input.client, input.sessionId, input.workspaceId]);

  useEffect(
    () => () => {
      scopeGeneration.current += 1;
      cancelTransfers(transfers.current);
      sources.current.clear();
      attempts.current.clear();
    },
    [],
  );

  const upload = useCallback(
    async (source: NativePickedFile, generation = scopeGeneration.current) => {
      if (scopeGeneration.current !== generation) return;
      const attempt = (attempts.current.get(source.id) ?? 0) + 1;
      attempts.current.set(source.id, attempt);
      cancelTransfers(transfers.current, source.id);
      const transfer = new AbortController();
      transfers.current.set(source.id, transfer);
      setAttachments((entries) =>
        entries.map((entry) =>
          entry.id === source.id ? { ...entry, status: "preparing", error: undefined } : entry,
        ),
      );
      const current = () =>
        scopeGeneration.current === generation &&
        attempts.current.get(source.id) === attempt &&
        sources.current.has(source.id);
      let shownPercent = -1;
      const onProgress = (fraction: number) => {
        // Native progress arrives about ten times a second; redraw per whole percent.
        const percent = Math.floor(Math.min(1, Math.max(0, fraction)) * 100);
        if (percent === shownPercent || !current()) return;
        shownPercent = percent;
        setAttachments((entries) =>
          entries.map((entry) =>
            entry.id === source.id && entry.status === "uploading"
              ? { ...entry, progress: percent / 100 }
              : entry,
          ),
        );
      };
      try {
        const { data, sha256, streamed } = await prepareNativeAttachmentData(t, {
          source,
          files: input.files,
          crypto: input.crypto,
          onProgress,
        });
        if (!current()) return;
        setAttachments((entries) =>
          entries.map((entry) =>
            entry.id === source.id
              ? { ...entry, status: "uploading", progress: streamed ? 0 : undefined }
              : entry,
          ),
        );
        const file = await input.client.uploadFile(input.workspaceId, {
          filename: source.name,
          contentType: source.contentType,
          data,
          ...(sha256 ? { sha256 } : {}),
          ...(input.scope ? { scope: input.scope } : {}),
          signal: transfer.signal,
        });
        if (!current()) return;
        transfers.current.delete(source.id);
        sources.current.delete(source.id);
        attempts.current.delete(source.id);
        setAttachments((entries) =>
          entries.map((entry) =>
            entry.id === source.id
              ? { ...entry, status: "ready", file, error: undefined, progress: undefined }
              : entry,
          ),
        );
      } catch (cause) {
        if (!current()) return;
        transfers.current.delete(source.id);
        setAttachments((entries) =>
          entries.map((entry) =>
            entry.id === source.id
              ? {
                  ...entry,
                  status: "failed",
                  error: errorMessage(cause),
                  progress: undefined,
                }
              : entry,
          ),
        );
      }
    },
    [input.client, input.crypto, input.files, input.scope, input.workspaceId, t],
  );

  const addFilesForGeneration = useCallback(
    async (files: NativePickedFile[], generation: number) => {
      await addNativeFilesForGeneration({
        files,
        generation,
        currentGeneration: () => scopeGeneration.current,
        hasSource: (id) => sources.current.has(id),
        rememberSource: (file) => sources.current.set(file.id, file),
        appendAttachments: (unique) =>
          setAttachments((current) => [
            ...current,
            ...unique.map(
              (file): NativeAttachment => ({
                id: file.id,
                name: file.name,
                contentType: file.contentType,
                sizeBytes: file.sizeBytes,
                kind: file.kind,
                ...(file.previewUri ? { previewUri: file.previewUri } : {}),
                ...(file.durationSeconds !== undefined
                  ? { durationSeconds: file.durationSeconds }
                  : {}),
                status: "preparing",
              }),
            ),
          ]),
        upload,
      });
    },
    [upload],
  );

  const addFiles = useCallback(
    async (files: NativePickedFile[]) =>
      await addFilesForGeneration(files, scopeGeneration.current),
    [addFilesForGeneration],
  );

  const pickFiles = useCallback(
    async (pick: () => Promise<NativePickedFile[]>) => {
      const generation = scopeGeneration.current;
      setError(null);
      await runNativeAttachmentPicker({
        generation,
        currentGeneration: () => scopeGeneration.current,
        pick,
        addFiles: addFilesForGeneration,
        onError: setError,
      });
    },
    [addFilesForGeneration],
  );

  const pickDocuments = useCallback(
    async () => await pickFiles(() => input.files.pickDocuments()),
    [input.files, pickFiles],
  );

  const pickImages = useCallback(
    async () => await pickFiles(() => input.files.pickImages()),
    [input.files, pickFiles],
  );

  const cameraPicker = input.files.takePhoto?.bind(input.files);
  const takePhoto = useCallback(async () => {
    if (cameraPicker) await pickFiles(cameraPicker);
  }, [cameraPicker, pickFiles]);

  const retry = useCallback(
    async (id: string) => {
      const source = sources.current.get(id);
      if (source) await upload(source);
    },
    [upload],
  );

  const remove = useCallback((id: string) => {
    cancelTransfers(transfers.current, id);
    sources.current.delete(id);
    attempts.current.delete(id);
    setAttachments((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const clear = useCallback(() => {
    cancelTransfers(transfers.current);
    sources.current.clear();
    attempts.current.clear();
    setAttachments([]);
    setError(null);
  }, []);
  const removeReadyFiles = useCallback((fileIds: Iterable<string>) => {
    const sent = [...fileIds];
    if (sent.length === 0) return;
    setAttachments((current) => removeReadyNativeAttachments(current, sent));
  }, []);
  const clearError = useCallback(() => setError(null), []);
  const restoreReady = useCallback((files: Iterable<FileAsset>) => {
    const restored = [...files];
    setAttachments((current) => {
      const kept = current.filter((entry) => entry.status !== "ready");
      return [
        ...restored.map(
          (file): NativeAttachment => ({
            id: `restored:${file.id}`,
            name: file.filename,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            kind: nativeAttachmentKind(file.contentType),
            status: "ready",
            file,
          }),
        ),
        ...kept,
      ];
    });
  }, []);

  const visibleState = projectNativeAttachmentScopeState(scopeMatches, attachments, error);
  const visibleAttachments = visibleState.attachments;
  const visibleError = visibleState.error;
  const readyResources = useMemo<ResourceRef[]>(
    () =>
      visibleAttachments.flatMap((attachment) =>
        attachment.status === "ready" && attachment.file
          ? [{ kind: "file" as const, fileId: attachment.file.id }]
          : [],
      ),
    [visibleAttachments],
  );
  const fileSource = useMemo<StoredFileSource>(
    () => ({ client: input.client, workspaceId: input.workspaceId, sessionId: input.sessionId }),
    [input.client, input.workspaceId, input.sessionId],
  );

  return {
    attachments: visibleAttachments,
    readyResources,
    uploading: visibleAttachments.some(
      (attachment) => attachment.status === "preparing" || attachment.status === "uploading",
    ),
    hasUnresolved: visibleAttachments.some((attachment) => attachment.status !== "ready"),
    error: visibleError,
    pickDocuments,
    pickImages,
    ...(cameraPicker ? { takePhoto } : {}),
    addFiles,
    retry,
    remove,
    removeReadyFiles,
    clear,
    clearError,
    restoreReady,
    fileSource,
  };
}
