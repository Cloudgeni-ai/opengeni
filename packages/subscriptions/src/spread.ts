/**
 * Spread hash (D-21, D-23): 32-bit FNV-1a over the UTF-16 code units of
 * `<session id>|<connection id>`, finished with the murmur3 32-bit finalizer.
 * Among otherwise equal connections a session takes the one with the lowest
 * value, so each session has a stable home that does not move when an
 * unrelated connection joins or leaves the pool, and placement needs no lock
 * across sessions (SUB-SEL-05). Without the finalizer, FNV-1a values of keys
 * that differ only in their last characters are not uniformly ordered, which
 * skews the spread (SUB-SEL-03, D-23).
 */
export function spreadHash(sessionId: string, connectionId: string): number {
  const key = `${sessionId}|${connectionId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}
