import type { ArtifactCatalogItem, ChatClient, OpenGeniClient } from "@opengeni/sdk";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { artifactKey, type ArtifactKindFilter } from "@/artifacts";

/*
 * The Artifacts list's data: one catalog page at a time, the last list for
 * each filter kept in memory so coming back paints at once, and the rows the
 * viewer reads (pin state, source chat) without asking the server again.
 */

const PAGE_SIZE = 30;
const SEARCH_DELAY_MS = 250;

type ListSnapshot = { items: ArtifactCatalogItem[]; nextCursor: string | null };

const lists = new Map<string, ListSnapshot>();
const items = new Map<string, ArtifactCatalogItem>();
const listeners = new Set<(workspaceId: string) => void>();

function listKey(workspaceId: string, kind: ArtifactKindFilter, query: string): string {
  return JSON.stringify([workspaceId, kind, query.trim().toLocaleLowerCase()]);
}

function itemKey(workspaceId: string, item: Pick<ArtifactCatalogItem, "kind" | "id">): string {
  return `${workspaceId}:${artifactKey(item)}`;
}

export function rememberArtifacts(workspaceId: string, rows: readonly ArtifactCatalogItem[]): void {
  for (const row of rows) items.set(itemKey(workspaceId, row), row);
}

/** A row the list already holds, so the viewer opens with its title, pin and chat. */
export function cachedArtifact(
  workspaceId: string,
  kind: ArtifactCatalogItem["kind"],
  id: string,
): ArtifactCatalogItem | null {
  const kinds: ArtifactCatalogItem["kind"][] =
    // A chat link names no editor, and a retained file may be an image.
    kind === "document"
      ? ["document", "presentation", "spreadsheet"]
      : kind === "file"
        ? ["file", "image"]
        : [kind];
  for (const each of kinds) {
    const row = items.get(itemKey(workspaceId, { kind: each, id }));
    if (row) return row;
  }
  return null;
}

export type ArtifactItemClient = Pick<
  ChatClient<OpenGeniClient>,
  "getWorkspaceArtifact" | "getRetainedArtifact" | "getEditableArtifact" | "listArtifactCatalog"
>;

/** A fresh reader identity for an editable artifact: 16 hex digits, never all zeros. */
export function newReplicaId(): string {
  const bytes = Crypto.getRandomBytes(8);
  bytes[7] = bytes[7]! | 1;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * An artifact the list doesn't hold yet (opened from a chat link): its kind,
 * title and state from its own record, then its list row (pin, source chat)
 * when a title search finds it.
 */
export async function loadArtifactItem(
  client: ArtifactItemClient,
  workspaceId: string,
  kind: ArtifactCatalogItem["kind"],
  id: string,
  title: string | undefined,
): Promise<ArtifactCatalogItem> {
  let item: ArtifactCatalogItem;
  if (kind === "site") {
    const { artifact } = await client.getWorkspaceArtifact(workspaceId, id);
    item = {
      id,
      kind: "site",
      title: artifact.title,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      status: artifact.status,
      ...(artifact.visibility ? { visibility: artifact.visibility } : {}),
      ...(artifact.currentVersion ? { versionId: artifact.currentVersion.id } : {}),
    };
  } else if (kind === "file" || kind === "image") {
    const file = await client.getRetainedArtifact(workspaceId, id);
    if (!file.available) throw new Error("This file is no longer available.");
    item = {
      id,
      kind: file.contentType.startsWith("image/") ? "image" : "file",
      title: title?.trim() || "File",
      createdAt: file.retainedAt,
      updatedAt: file.retainedAt,
      status: "active",
      file,
      contentType: file.contentType,
      sizeBytes: file.originalBytes,
    };
  } else {
    const artifact = await client.getEditableArtifact(workspaceId, id, {
      replicaId: newReplicaId(),
    });
    item = {
      id,
      kind: artifact.modality,
      title: artifact.title,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      status: artifact.lifecycle,
      ...(artifact.visibility ? { visibility: artifact.visibility } : {}),
      ...(artifact.ownedByViewer !== undefined ? { ownedByViewer: artifact.ownedByViewer } : {}),
    };
  }
  try {
    const page = await client.listArtifactCatalog(workspaceId, {
      q: item.title,
      kind: item.kind,
      limit: 10,
    });
    const row = page.items.find((candidate) => candidate.id === id);
    if (row) item = { ...row, ...(item.file && !row.file ? { file: item.file } : {}) };
  } catch {
    // The row only adds pin state and the source chat.
  }
  rememberArtifacts(workspaceId, [item]);
  return item;
}

/**
 * After a change made in the viewer (pin, delete, a duplicate): patch the row
 * (or drop it with null) everywhere it is kept and let open lists refresh.
 */
export function artifactChanged(
  workspaceId: string,
  item: Pick<ArtifactCatalogItem, "kind" | "id">,
  next: ArtifactCatalogItem | null,
): void {
  const key = itemKey(workspaceId, item);
  if (next) items.set(key, next);
  else items.delete(key);
  const prefix = `${JSON.stringify([workspaceId]).slice(0, -1)},`;
  for (const [cacheKey, snapshot] of lists) {
    if (!cacheKey.startsWith(prefix)) continue;
    lists.set(cacheKey, {
      ...snapshot,
      items: next
        ? snapshot.items.map((row) => (artifactKey(row) === artifactKey(item) ? next : row))
        : snapshot.items.filter((row) => artifactKey(row) !== artifactKey(item)),
    });
  }
  for (const listener of listeners) listener(workspaceId);
}

export type ArtifactCatalogState = {
  items: ArtifactCatalogItem[];
  /** No page yet for this filter (the first load, with nothing kept to show). */
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => void;
};

/** The workspace's artifacts for a type and search, newest change first. */
export function useArtifactCatalog(
  client: Pick<ChatClient<OpenGeniClient>, "listArtifactCatalog">,
  workspaceId: string,
  kind: ArtifactKindFilter,
  query: string,
): ArtifactCatalogState {
  // Typing settles before it searches; clearing the field shows the list at once.
  const [settledQuery, setSettledQuery] = useState(query);
  useEffect(() => {
    if (!query.trim()) {
      setSettledQuery("");
      return;
    }
    const timer = setTimeout(() => setSettledQuery(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const key = listKey(workspaceId, kind, settledQuery);
  const [snapshot, setSnapshot] = useState<{ key: string; value: ListSnapshot | null }>(() => ({
    key,
    value: lists.get(key) ?? null,
  }));
  const [error, setError] = useState<string | null>(null);
  const loadingMore = useRef(false);
  const current = snapshot.key === key ? snapshot.value : (lists.get(key) ?? null);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const page = await client.listArtifactCatalog(workspaceId, {
        limit: PAGE_SIZE,
        sort: "updated",
        status: "active",
        ...(kind === "all" ? {} : { kind }),
        ...(settledQuery.trim() ? { q: settledQuery.trim() } : {}),
        ...(cursor ? { cursor } : {}),
      });
      rememberArtifacts(workspaceId, page.items);
      return page;
    },
    [client, kind, settledQuery, workspaceId],
  );

  const refresh = useCallback(async () => {
    try {
      const page = await fetchPage(null);
      const next = { items: page.items, nextCursor: page.nextCursor };
      lists.set(key, next);
      setSnapshot({ key, value: next });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [fetchPage, key]);

  useEffect(() => {
    setSnapshot({ key, value: lists.get(key) ?? null });
    setError(null);
    void refresh();
  }, [key, refresh]);

  // A change made in the viewer shows here without a reload.
  useEffect(() => {
    const listener = (changed: string) => {
      if (changed === workspaceId) setSnapshot({ key, value: lists.get(key) ?? null });
    };
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, [key, workspaceId]);

  const loadMore = useCallback(() => {
    const cursor = current?.nextCursor;
    if (!cursor || loadingMore.current) return;
    loadingMore.current = true;
    void fetchPage(cursor)
      .then((page) => {
        const kept = lists.get(key) ?? { items: [], nextCursor: null };
        const seen = new Set(kept.items.map(artifactKey));
        const next = {
          items: [...kept.items, ...page.items.filter((row) => !seen.has(artifactKey(row)))],
          nextCursor: page.nextCursor,
        };
        lists.set(key, next);
        setSnapshot({ key, value: next });
      })
      .catch(() => undefined)
      .finally(() => {
        loadingMore.current = false;
      });
  }, [current?.nextCursor, fetchPage, key]);

  return {
    items: current?.items ?? [],
    loading: !current && !error,
    error,
    hasMore: Boolean(current?.nextCursor),
    refresh,
    loadMore,
  };
}
