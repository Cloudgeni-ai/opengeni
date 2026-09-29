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

/** Register (or clear with `null`) the loader for `@pierre/diffs/react`. */
export function registerPierreDiffs(next: PierreDiffsLoader | null): void {
  loader = next;
  loaded = null;
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
