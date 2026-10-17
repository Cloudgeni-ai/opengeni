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
 * A failed read is never kept, so the next caller reads again.
 */
type ClientConfigSource<T> = { getClientConfig: () => Promise<T> };
type Read = { promise: Promise<unknown>; pending: boolean };

const reads = new WeakMap<object, Read>();

function startRead<T>(client: ClientConfigSource<T>): Promise<T> {
  const promise = client.getClientConfig();
  const read: Read = { promise, pending: true };
  reads.set(client, read);
  promise.then(
    () => {
      read.pending = false;
    },
    () => {
      if (reads.get(client) === read) reads.delete(client);
    },
  );
  return promise;
}

export function joinClientConfigRead<T>(client: ClientConfigSource<T>): Promise<T> {
  const read = reads.get(client);
  return read?.pending ? (read.promise as Promise<T>) : startRead(client);
}

export function cachedClientConfigRead<T>(client: ClientConfigSource<T>): Promise<T> {
  const read = reads.get(client);
  return read ? (read.promise as Promise<T>) : startRead(client);
}
