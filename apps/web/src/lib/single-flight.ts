/**
 * Reuse one in-flight read for one identity. The entry is removed as soon as
 * the request settles, so this coalesces concurrent callers without caching
 * stale data.
 */
export function runSingleFlight<Key, Value>(
  pending: Map<Key, Promise<Value>>,
  key: Key,
  load: () => Promise<Value>,
): Promise<Value> {
  const existing = pending.get(key);
  if (existing) return existing;

  const request = load();
  pending.set(key, request);
  const clear = () => {
    if (pending.get(key) === request) pending.delete(key);
  };
  void request.then(clear, clear);
  return request;
}
