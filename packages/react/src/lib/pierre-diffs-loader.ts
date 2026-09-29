/**
 * `@pierre/diffs` is an optional heavy peer. The package never names it in an
 * `import()` that the conversation surfaces can reach: bundlers such as
 * Turbopack resolve every reachable dynamic import at build time, so a host
 * without the peer would fail to build. Hosts that install it opt in once with
 * `enablePierreDiffs()` from `@opengeni/react/diffs` (or register their own
 * loader); otherwise diffs and file views use the plain-text renderer.
 */
export type PierreDiffsLoader = () => Promise<unknown>;

let loader: PierreDiffsLoader | null = null;
let loaded: Promise<unknown> | null = null;
let revision = 0;
const listeners = new Set<() => void>();

/**
 * Register (or clear with `null`) the loader for `@pierre/diffs/react`.
 * Views already on screen retry with the new loader, so a host may register
 * lazily (for example from the route that renders diffs).
 */
export function registerPierreDiffs(next: PierreDiffsLoader | null): void {
  if (next === loader) return;
  loader = next;
  loaded = null;
  revision += 1;
  for (const listener of listeners) listener();
}

/** Changes whenever the registered loader changes (for `useSyncExternalStore`). */
export function pierreDiffsRevision(): number {
  return revision;
}

export function subscribePierreDiffs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Resolve the registered `@pierre/diffs/react` module; rejects when none is registered. */
export function loadPierreDiffs(): Promise<unknown> {
  if (!loader) {
    return Promise.reject(
      new Error(
        "@pierre/diffs is not enabled; call enablePierreDiffs() from @opengeni/react/diffs",
      ),
    );
  }
  loaded ??= loader().catch((error: unknown) => {
    loaded = null;
    throw error;
  });
  return loaded;
}
