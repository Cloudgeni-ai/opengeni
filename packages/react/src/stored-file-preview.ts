import type { FileAsset, OpenGeniClient } from "@opengeni/sdk";
import type { ChatClient } from "@opengeni/sdk";
import { useCallback, useEffect, useState } from "react";

/**
 * The reads that show a file already stored on the server: its metadata and a
 * short-lived signed URL. Both are optional so an upload-only client still
 * shows a named chip; it just cannot show the picture.
 */
export type StoredFileClientLike = Partial<
  Pick<ChatClient<OpenGeniClient>, "getFile" | "createFileDownloadUrl">
>;

/**
 * Where a stored file is read from. `sessionId` lets a chat's participants
 * read files shared into that chat; without it only the reader's own files
 * resolve.
 */
export type StoredFileSource = {
  client: StoredFileClientLike;
  workspaceId: string;
  sessionId?: string | null | undefined;
};

export function isStoredImage(file: Pick<FileAsset, "contentType"> | null | undefined): boolean {
  return Boolean(file?.contentType.startsWith("image/"));
}

// Signed URLs are reused until shortly before they expire, so every surface
// showing one file (composer, queue, timeline, another chat view) shares one
// read instead of each minting its own.
const SIGNED_URL_EXPIRY_MARGIN_MS = 60_000;
const MAX_CACHED_FILES_PER_CLIENT = 500;

type CachedFile = {
  file?: Promise<FileAsset> | undefined;
  preview?: { url: Promise<string>; reuseUntil: number } | undefined;
};

const cachesByClient = new WeakMap<object, Map<string, CachedFile>>();

function cachedFile(source: StoredFileSource, fileId: string): CachedFile {
  let cache = cachesByClient.get(source.client);
  if (!cache) {
    cache = new Map();
    cachesByClient.set(source.client, cache);
  }
  const key = `${source.workspaceId}\u0000${source.sessionId ?? ""}\u0000${fileId}`;
  let entry = cache.get(key);
  if (!entry) {
    if (cache.size >= MAX_CACHED_FILES_PER_CLIENT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    entry = {};
    cache.set(key, entry);
  }
  return entry;
}

function readOptions(source: StoredFileSource): { sessionId?: string } {
  return source.sessionId ? { sessionId: source.sessionId } : {};
}

/** Read a stored file's metadata (shared between every caller of this client). */
export async function readStoredFile(source: StoredFileSource, fileId: string): Promise<FileAsset> {
  const getFile = source.client.getFile;
  if (typeof getFile !== "function") throw new Error("This client cannot read stored files.");
  const entry = cachedFile(source, fileId);
  if (!entry.file) {
    const read = getFile.call(source.client, source.workspaceId, fileId, readOptions(source));
    entry.file = read;
    read.catch(() => {
      if (entry.file === read) entry.file = undefined;
    });
  }
  return await entry.file;
}

/**
 * Signed URL that shows a stored file. This is the one way every surface gets
 * an image preview from the server. `refresh` mints a new URL, for example
 * after the previous one stopped loading.
 */
export async function readStoredFilePreviewUrl(
  source: StoredFileSource,
  fileId: string,
  options: { refresh?: boolean | undefined } = {},
): Promise<string> {
  const createDownloadUrl = source.client.createFileDownloadUrl;
  if (typeof createDownloadUrl !== "function") {
    throw new Error("This client cannot preview stored files.");
  }
  const entry = cachedFile(source, fileId);
  if (!options.refresh && entry.preview && entry.preview.reuseUntil > Date.now()) {
    return await entry.preview.url;
  }
  const preview: NonNullable<CachedFile["preview"]> = {
    reuseUntil: Number.POSITIVE_INFINITY,
    url: createDownloadUrl
      .call(source.client, source.workspaceId, fileId, readOptions(source))
      .then((signed) => {
        const expiresAt = Date.parse(signed.expiresAt);
        preview.reuseUntil = Number.isFinite(expiresAt)
          ? expiresAt - SIGNED_URL_EXPIRY_MARGIN_MS
          : Date.now();
        return signed.url;
      }),
  };
  entry.preview = preview;
  preview.url.catch(() => {
    if (entry.preview === preview) entry.preview = undefined;
  });
  return await preview.url;
}

function sourceKey(source: StoredFileSource | null | undefined): string {
  return source ? `${source.workspaceId}\u0000${source.sessionId ?? ""}` : "";
}

export type StoredFiles = {
  /** Metadata by file id; `null` when the file could not be read. */
  files: ReadonlyMap<string, FileAsset | null>;
  /** True once every requested id has resolved (or failed). */
  ready: boolean;
};

/**
 * Metadata for a list of stored files, read as one batch so a surface can lay
 * out images and other files without flashing an image as a file chip first.
 */
export function useStoredFiles(
  source: StoredFileSource | null | undefined,
  fileIds: readonly string[],
): StoredFiles {
  const client = source?.client;
  const scope = sourceKey(source);
  const ids = fileIds.join(",");
  const key = `${scope}\u0000${ids}`;
  // The map remembers which key it was read for: while a new list loads, the
  // previous list's metadata must never stand in for it.
  const [loaded, setLoaded] = useState<{ key: string; files: Map<string, FileAsset | null> }>({
    key: "",
    files: new Map(),
  });
  const workspaceId = source?.workspaceId;
  const sessionId = source?.sessionId;
  useEffect(() => {
    let current = true;
    const list = ids ? ids.split(",") : [];
    if (!client || workspaceId === undefined || list.length === 0) {
      setLoaded({ key, files: new Map(list.map((id) => [id, null] as const)) });
      return;
    }
    const read = { client, workspaceId, sessionId };
    void Promise.all(
      list.map(async (id) => {
        try {
          return [id, await readStoredFile(read, id)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((entries) => {
      if (current) setLoaded({ key, files: new Map(entries) });
    });
    return () => {
      current = false;
    };
  }, [client, ids, key, sessionId, workspaceId]);
  return loaded.key === key
    ? { files: loaded.files, ready: true }
    : { files: EMPTY_FILES, ready: ids.length === 0 };
}

const EMPTY_FILES: ReadonlyMap<string, FileAsset | null> = new Map();

export type StoredFilePreview = {
  /** What to show: the local preview while it works, otherwise the stored copy. */
  url: string | undefined;
  /** True once neither the local preview nor the stored copy can be shown. */
  failed: boolean;
  /** Report that `url` did not load; falls back to the stored copy, then re-signs it once. */
  onError: () => void;
};

/**
 * The preview of one attached image. A local preview (an object URL or a
 * picked photo) is used while it works; otherwise, and on every other device
 * or after a reload, the stored copy loads from the server.
 */
export function useStoredFilePreview(
  source: StoredFileSource | null | undefined,
  file: Pick<FileAsset, "id" | "contentType"> | null | undefined,
  options: { localUrl?: string | undefined } = {},
): StoredFilePreview {
  const localUrl = options.localUrl;
  const fileId = file && isStoredImage(file) ? file.id : undefined;
  const client = source?.client;
  const workspaceId = source?.workspaceId;
  const sessionId = source?.sessionId;
  const key = `${sourceKey(source)}\u0000${fileId ?? ""}\u0000${localUrl ?? ""}`;
  const [state, setState] = useState<PreviewState>(() => freshPreviewState(key));
  // A new file, source or local preview starts over; nothing from the previous one bleeds in.
  const current = state.key === key ? state : freshPreviewState(key);
  const useLocal = Boolean(localUrl) && !current.localBroken;
  const canLoad =
    fileId !== undefined &&
    workspaceId !== undefined &&
    typeof client?.createFileDownloadUrl === "function";
  const attempt = current.attempt;
  useEffect(() => {
    if (useLocal || !canLoad || !client || workspaceId === undefined || !fileId) return;
    let active = true;
    const update = (change: Partial<PreviewState>) =>
      setState((previous) => ({
        ...(previous.key === key ? previous : freshPreviewState(key)),
        ...change,
      }));
    readStoredFilePreviewUrl({ client, workspaceId, sessionId }, fileId, {
      refresh: attempt > 0,
    }).then(
      (url) => {
        if (active) update({ stored: url, failed: false });
      },
      () => {
        if (active) update({ stored: undefined, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, canLoad, client, fileId, key, sessionId, useLocal, workspaceId]);
  const onError = useCallback(() => {
    setState((previous) => {
      const base = previous.key === key ? previous : freshPreviewState(key);
      if (localUrl && !base.localBroken) return { ...base, localBroken: true };
      if (base.attempt === 0 && canLoad) return { ...base, attempt: 1, stored: undefined };
      return { ...base, stored: undefined, failed: true };
    });
  }, [canLoad, key, localUrl]);
  if (useLocal) return { url: localUrl, failed: false, onError };
  return {
    url: current.stored,
    failed: current.failed || (!canLoad && fileId !== undefined),
    onError,
  };
}

type PreviewState = {
  key: string;
  localBroken: boolean;
  attempt: number;
  stored?: string | undefined;
  failed: boolean;
};

function freshPreviewState(key: string): PreviewState {
  return { key, localBroken: false, attempt: 0, failed: false };
}
