import type { RetainedArtifactMetadata } from "@opengeni/sdk";
import type { createWorkspaceRetainedArtifactLoader } from "@opengeni/react";

type RetainedArtifactLoader = ReturnType<typeof createWorkspaceRetainedArtifactLoader>;
type LoadedSource = Awaited<ReturnType<RetainedArtifactLoader>>;

/*
 * Retained images are immutable (integrity-addressed), so a tab switch, search
 * or scroll that remounts a thumbnail should reuse what this page already
 * fetched instead of downloading the metadata and every byte again. Bounded
 * by entries and bytes; failures are never kept, so Retry always refetches.
 */
const MAX_ENTRIES = 96;
const MAX_BYTES = 96 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
// Signed URLs are reused only while comfortably inside their lifetime.
const URL_EXPIRY_MARGIN_MS = 60_000;

type Entry = { promise: Promise<unknown>; value?: unknown; size: number; expiresAt?: number };

export class RetainedImageCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;

  /** The settled value, if this key has one that is still fresh. */
  peek<T>(key: string): T | undefined {
    const entry = this.fresh(key);
    return entry && "value" in entry ? (entry.value as T) : undefined;
  }

  get<T>(
    key: string,
    create: () => Promise<T>,
    describe: (value: T) => { size?: number; expiresAt?: number } = () => ({}),
  ): Promise<T> {
    const existing = this.fresh(key);
    if (existing) return existing.promise as Promise<T>;
    const promise = create();
    const entry: Entry = { promise, size: 0 };
    this.entries.set(key, entry);
    promise.then(
      (value) => {
        if (this.entries.get(key) !== entry) return;
        const { size = 0, expiresAt } = describe(value);
        if (size > MAX_ENTRY_BYTES) {
          this.entries.delete(key);
          return;
        }
        entry.value = value;
        entry.size = size;
        entry.expiresAt = expiresAt;
        this.bytes += size;
        this.trim();
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    this.trim();
    return promise;
  }

  /** Forget every key under a prefix (an artifact's metadata and bytes). */
  forget(prefix: string) {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.remove(key);
  }

  private fresh(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      this.remove(key);
      return undefined;
    }
    // Least recently used goes first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.size;
  }

  private trim() {
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.remove(oldest);
    }
  }
}

let caches = new WeakMap<object, RetainedImageCache>();

/** One cache per authenticated client, so a new sign-in never sees old bytes. */
export function retainedImageCache(client: object) {
  let cache = caches.get(client);
  if (!cache) {
    cache = new RetainedImageCache();
    caches.set(client, cache);
  }
  return cache;
}

export function resetRetainedImageCaches() {
  caches = new WeakMap();
}

/** Key prefix for one artifact under one access-key version and workspace. */
export function retainedImageScope(
  accessKeyVersion: number,
  workspaceId: string,
  artifactId: string,
) {
  return `${accessKeyVersion}:${workspaceId}:${artifactId}:`;
}

export function cachedRetainedMetadata(
  cache: RetainedImageCache,
  scope: string,
  fetch: () => Promise<RetainedArtifactMetadata>,
) {
  return cache.get(`${scope}meta`, fetch);
}

/**
 * Share one download per artifact version. The shared request is not tied to
 * the first caller's abort signal: a card unmounted mid-load still fills the
 * cache for its next mount, and callers ignore results after their own abort.
 */
export function cachedRetainedArtifactLoader(
  cache: RetainedImageCache,
  accessKeyVersion: number,
  workspaceId: string,
  load: RetainedArtifactLoader,
): RetainedArtifactLoader {
  return (artifact, signal, options) => {
    signal.throwIfAborted();
    const scope = retainedImageScope(accessKeyVersion, workspaceId, artifact.artifactId);
    return cache.get<LoadedSource>(
      `${scope}bytes:${artifact.sha256}:${options?.prefer ?? ""}`,
      () => load(artifact, new AbortController().signal, options),
      (source) => {
        if (!source) return {};
        if (source instanceof Uint8Array) return { size: source.byteLength };
        const expiresAt = Date.parse(source.expiresAt ?? "");
        return { expiresAt: Number.isFinite(expiresAt) ? expiresAt - URL_EXPIRY_MARGIN_MS : 0 };
      },
    );
  };
}
