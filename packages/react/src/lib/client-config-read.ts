/**
 * The deployment's unscoped client config (`GET /v1/config/client`) is read by
 * the provider's API-contract check, the conversation capability flags, the
 * session-proxy scope and the artifact viewer, usually in the same commit.
 * Reads through one client object share a request:
 *
 * - `joinClientConfigRead` returns the read in flight, or starts a new one. For
 *   callers that need the current config (the contract check before a live
 *   stream opens): they never receive an older, already settled result.
 * - `cachedClientConfigRead` also reuses the last successful read, for values
 *   that do not change while a page is open (capability flags).
 *
 * Workspace-scoped reads (`GET /v1/config/client?workspaceId=`, behind the
 * model catalog and voice availability) join the same way per workspace.
 *
 * A host that read the unscoped config itself at startup (the console's
 * bootstrap) records it with `rememberClientConfigRead`, so the first contract
 * check moments later (`settledWithinMs`) and the capability flags take it
 * instead of reading it again. Only a read the host started after creating
 * this client is taken, and only for `MOUNT_READ_REUSE_MS`: after that every
 * caller, `cachedClientConfigRead` included, reads through the client.
 *
 * A failed read is never kept, so the next caller reads again.
 */
import { MOUNT_READ_REUSE_MS } from "./mount-read-reuse";

type ClientConfigSource<T> = {
  getClientConfig: (options?: { workspaceId?: string }) => Promise<T>;
};
type Read = {
  promise: Promise<unknown>;
  pending: boolean;
  settledAt: number | null;
  /** Recorded by the host rather than read through the client. */
  seeded?: boolean;
};

// Per client object, per scope: "" is the deployment's unscoped config, any
// other key is that workspace's config.
const reads = new WeakMap<object, Map<string, Read>>();
// When each client was registered with `noteClientCreated`.
const createdAt = new WeakMap<object, number>();

function scopedReads(client: object): Map<string, Read> {
  let scoped = reads.get(client);
  if (!scoped) {
    scoped = new Map();
    reads.set(client, scoped);
  }
  return scoped;
}

/** The recorded read for `key`, dropping a host-recorded one past its reuse window. */
function currentRead(client: object, key: string): Read | undefined {
  const scoped = reads.get(client);
  const read = scoped?.get(key);
  if (read?.seeded && Date.now() - (read.settledAt ?? 0) >= MOUNT_READ_REUSE_MS) {
    scoped?.delete(key);
    return undefined;
  }
  return read;
}

function startRead<T>(client: ClientConfigSource<T>, workspaceId: string | undefined): Promise<T> {
  const key = workspaceId ?? "";
  const promise = workspaceId ? client.getClientConfig({ workspaceId }) : client.getClientConfig();
  const read: Read = { promise, pending: true, settledAt: null };
  const scoped = scopedReads(client);
  scoped.set(key, read);
  promise.then(
    () => {
      read.pending = false;
      read.settledAt = Date.now();
    },
    () => {
      if (scoped.get(key) === read) scoped.delete(key);
    },
  );
  return promise;
}

export function joinClientConfigRead<T>(
  client: ClientConfigSource<T>,
  workspaceId?: string | undefined,
  options: { settledWithinMs?: number | undefined } = {},
): Promise<T> {
  const read = currentRead(client, workspaceId ?? "");
  if (read?.pending) return read.promise as Promise<T>;
  const within = options.settledWithinMs;
  if (
    read &&
    within !== undefined &&
    read.settledAt !== null &&
    Date.now() - read.settledAt < within
  )
    return read.promise as Promise<T>;
  return startRead(client, workspaceId);
}

/**
 * Note when `client` was created, so `rememberClientConfigRead` refuses a read
 * started before it (another identity's, or before sign-in).
 */
export function noteClientCreated(client: object, at = Date.now()): void {
  if (!createdAt.has(client)) createdAt.set(client, at);
}

/**
 * Record an unscoped config the host read some other way, started at
 * `startedAt` and settled at `readAt` (epoch ms). Refused for a client not
 * noted with `noteClientCreated`, a read started before the client, or one
 * older than `MOUNT_READ_REUSE_MS`. A read through `client` already in flight
 * or recorded later wins.
 */
export function rememberClientConfigRead(
  client: ClientConfigSource<unknown>,
  config: unknown,
  read: { startedAt: number; readAt: number },
): void {
  const created = createdAt.get(client);
  if (created === undefined || read.startedAt < created) return;
  if (Date.now() - read.readAt >= MOUNT_READ_REUSE_MS) return;
  const scoped = scopedReads(client);
  const current = scoped.get("");
  if (current && (current.pending || (current.settledAt ?? 0) >= read.readAt)) return;
  scoped.set("", {
    promise: Promise.resolve(config),
    pending: false,
    settledAt: read.readAt,
    seeded: true,
  });
}

export function cachedClientConfigRead<T>(client: ClientConfigSource<T>): Promise<T> {
  const read = currentRead(client, "");
  return read ? (read.promise as Promise<T>) : startRead(client, undefined);
}

/**
 * Read the deployment's client config (or one workspace's, with
 * `workspaceId`), joining a read of the same scope already in flight through
 * this client, so a screen whose parts each need the config sends one request.
 */
export function readClientConfig<T>(
  client: ClientConfigSource<T>,
  workspaceId?: string | undefined,
): Promise<T> {
  return joinClientConfigRead(client, workspaceId);
}
