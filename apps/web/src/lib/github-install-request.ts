/**
 * A GitHub App install request this browser sent for a workspace.
 *
 * A GitHub organization member who isn't an owner can only *request* the
 * Opengeni app; GitHub then asks the organization owners to approve. GitHub
 * never tells Opengeni which workspace the request was for, and an approved
 * install is never connected to a workspace automatically (an organization
 * owner connects it from Opengeni). So this is a display hint only, kept in this
 * browser: it lets the GitHub card say "waiting for an owner" instead of
 * offering the same dead end again. It grants nothing and is cleared once the
 * workspace's GitHub connection exists.
 */

const STORAGE_KEY = "opengeni.githubInstallRequests.v1";
/** Fired on this window when the hint changes; other tabs see a `storage` event. */
export const GITHUB_INSTALL_REQUEST_EVENT = "opengeni:github-install-request";
/** Owners can take a while; after this the hint quietly disappears. */
export const GITHUB_INSTALL_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;

type Requests = Record<string, number>;

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readAll(storage: Storage | null, now: number): Requests {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const fresh: Requests = {};
    for (const [workspaceId, requestedAt] of Object.entries(parsed)) {
      if (
        typeof requestedAt === "number" &&
        Number.isFinite(requestedAt) &&
        requestedAt <= now &&
        now - requestedAt < GITHUB_INSTALL_REQUEST_TTL_MS
      ) {
        fresh[workspaceId] = requestedAt;
      }
    }
    return fresh;
  } catch {
    return {};
  }
}

function writeAll(storage: Storage | null, requests: Requests): void {
  if (!storage) return;
  try {
    const entries = Object.entries(requests)
      .sort(([, left], [, right]) => right - left)
      .slice(0, MAX_ENTRIES);
    if (entries.length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage can be full or blocked; the hint is optional.
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(GITHUB_INSTALL_REQUEST_EVENT));
  }
}

export function recordGitHubInstallRequest(
  workspaceId: string,
  options: { storage?: Storage | null; now?: number } = {},
): void {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const now = options.now ?? Date.now();
  writeAll(storage, { ...readAll(storage, now), [workspaceId]: now });
}

/** When this browser last requested a GitHub install for the workspace, if recently. */
export function readGitHubInstallRequest(
  workspaceId: string,
  options: { storage?: Storage | null; now?: number } = {},
): number | null {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  return readAll(storage, options.now ?? Date.now())[workspaceId] ?? null;
}

export function clearGitHubInstallRequest(
  workspaceId: string,
  options: { storage?: Storage | null; now?: number } = {},
): void {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const requests = readAll(storage, options.now ?? Date.now());
  if (!(workspaceId in requests)) return;
  delete requests[workspaceId];
  writeAll(storage, requests);
}

/** Re-read the hint when it changes in this tab or another one. */
export function subscribeGitHubInstallRequests(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(GITHUB_INSTALL_REQUEST_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(GITHUB_INSTALL_REQUEST_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
