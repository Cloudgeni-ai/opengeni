// The desktop window bar's title claims, in a module of its own (React only),
// so page headers, overlays and the shells can share it without importing one
// another.
import { createContext, useContext, useId, useLayoutEffect, useMemo, type ReactNode } from "react";

/**
 * The desktop window bar's title line, when the page's shell draws one (the
 * macOS app): the first page header below claims it with its title, which is
 * then shown in the bar, and keeps its heading only for assistive tech, so the
 * title isn't shown twice. Provided by the shells (`useWindowBarRow`).
 */
export const PageHeaderWindowBarContext = createContext<{
  /**
   * A header's title, or null while it has none to show; keeps its place. A
   * fallback claim shows only while no other header has a title.
   */
  set(id: string, title: string | null, fallback?: boolean): void;
  release(id: string): void;
  /** The header whose title the bar shows. */
  owner: string | null;
} | null>(null);

/**
 * Headers inside an overlay (a dialog or sheet) never take the window bar:
 * the overlays' content wraps its children in this.
 *
 * With `fallback`, headers inside take the bar only while no other header has
 * a title: a page that stays mounted, hidden, under the pages it opens (the
 * Capabilities catalog) names the bar until an open page names it, including
 * while that page is loading or has no header.
 */
export function WindowBarTitleBoundary({
  fallback = false,
  children,
}: {
  fallback?: boolean | undefined;
  children: ReactNode;
}) {
  const enclosing = useContext(PageHeaderWindowBarContext);
  const value = useMemo(
    () =>
      fallback && enclosing
        ? {
            ...enclosing,
            set: (id: string, title: string | null) => enclosing.set(id, title, true),
          }
        : null,
    [fallback, enclosing],
  );
  return (
    <PageHeaderWindowBarContext.Provider value={value}>
      {children}
    </PageHeaderWindowBarContext.Provider>
  );
}

export function useWindowBarTitle(title: ReactNode): boolean {
  const windowBar = useContext(PageHeaderWindowBarContext);
  const id = useId();
  const text = typeof title === "string" ? title : null;
  const set = windowBar?.set;
  const release = windowBar?.release;
  useIsomorphicLayoutEffect(() => {
    set?.(id, text || null);
  }, [id, set, text]);
  useIsomorphicLayoutEffect(() => () => release?.(id), [id, release]);
  return windowBar?.owner === id;
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined"
    ? (_effect: () => unknown, _deps: unknown[]) => {}
    : useLayoutEffect;
