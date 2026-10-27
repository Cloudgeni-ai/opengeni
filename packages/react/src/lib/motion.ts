/**
 * Live `prefers-reduced-motion` check for JS-driven motion (scroll glides,
 * streaming word reveals). CSS animations are already neutralized globally in
 * styles/index.css; this lets the imperative paths skip their work entirely.
 */
let query: MediaQueryList | null | undefined;

export function prefersReducedMotion(): boolean {
  if (query === undefined) {
    query =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
  }
  return query?.matches ?? false;
}
