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
 * instead of reading it again.
 *
 * A failed read is never kept, so the next caller reads again.
 */
type ClientConfigSource<T> = {
  getClientConfig: (options?: { workspaceId?: string }) => Promise<T>;
};
type Read = { promise: Promise<unknown>; pending: boolean; settledAt: number | null };

// Per client object, per scope: "" is the deployment's unscoped config, any
// other key is that workspace's config.
const reads = new WeakMap<object, Map<string, Read>>();

function scopedReads(client: object): Map<string, Read> {
  let scoped = reads.get(client);
  if (!scoped) {
    scoped = new Map();
    reads.set(client, scoped);
  }
  return scoped;
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
  const read = reads.get(client)?.get(workspaceId ?? "");
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
 * Record an unscoped config the host read some other way at `readAt` (epoch
 * ms). A read through `client` already in flight or recorded later wins.
 */
export function rememberClientConfigRead(
  client: ClientConfigSource<unknown>,
  config: unknown,
  readAt: number,
): void {
  const scoped = scopedReads(client);
  const current = scoped.get("");
  if (current && (current.pending || (current.settledAt ?? 0) >= readAt)) return;
  scoped.set("", { promise: Promise.resolve(config), pending: false, settledAt: readAt });
}

export function cachedClientConfigRead<T>(client: ClientConfigSource<T>): Promise<T> {
  const read = reads.get(client)?.get("");
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
