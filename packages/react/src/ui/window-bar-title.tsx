// The desktop window bar's title claims, in a module of its own (React only),
// so page headers, overlays and the shells can share it without importing one
// another.
import { createContext, useContext, useId, useLayoutEffect, useMemo, type ReactNode } from "react";

/**
 * A step in the window bar's trail before the page's title: the rail section
 * ("Knowledge") and the list a detail page belongs to ("Library"). Clicking
 * it goes there.
 */
export interface WindowBarCrumb {
  label: string;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
}

/**
 * Where a detail page sits, for the header below it to put in the window
 * bar's trail: the list it belongs to (its back link) and, when it differs
 * from the shell's, the section ("Agents" for an agent's Memory, which lives
 * in Knowledge). Provided by `DetailPage`.
 */
export interface WindowBarPlace {
  parent: WindowBarCrumb | null;
  section?: WindowBarCrumb | null | undefined;
}

export const WindowBarPlaceContext = createContext<WindowBarPlace | null>(null);

/**
 * Told whether a header below names the window bar, so a `DetailPage` drops
 * its back link only while its own header carries it into the bar's trail.
 */
export const WindowBarOwnerReportContext = createContext<((owns: boolean) => void) | null>(null);

/**
 * The desktop window bar's title line, when the page's shell draws one (the
 * macOS app): the first page header below claims it with its title, which is
 * then shown in the bar, and keeps its heading only for assistive tech, so the
 * title isn't shown twice. Provided by the shells (`useWindowBarRow`).
 */
export const PageHeaderWindowBarContext = createContext<{
  /**
   * A header's title, or null while it has none to show; keeps its place. A
   * fallback claim shows only while no other header has a title. A copyable
   * title (a Site's) can be right-clicked in the bar to copy it; others stay
   * part of the bar's drag region.
   */
  set(
    id: string,
    title: string | null,
    fallback?: boolean,
    copyable?: boolean,
    place?: WindowBarPlace | null,
  ): void;
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
            set: (
              id: string,
              title: string | null,
              _fallback?: boolean,
              copyable?: boolean,
              place?: WindowBarPlace | null,
            ) => enclosing.set(id, title, true, copyable, place),
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

/**
 * Claims the window bar for `title`. With `fallback`, the claim yields to any
 * other header with a title, as headers in a `WindowBarTitleBoundary fallback`
 * do: a page that stays mounted under a page it opens keeps naming the bar
 * only until that page names it. Inside a fallback boundary every claim is a
 * fallback already, so there the first one keeps the bar.
 */
export function useWindowBarTitle(
  title: ReactNode,
  fallback = false,
  { copyable = false }: { copyable?: boolean } = {},
): boolean {
  const windowBar = useContext(PageHeaderWindowBarContext);
  const place = useContext(WindowBarPlaceContext);
  const id = useId();
  const text = typeof title === "string" ? title : null;
  const set = windowBar?.set;
  const release = windowBar?.release;
  useIsomorphicLayoutEffect(() => {
    set?.(id, text || null, fallback, copyable, place);
  }, [id, set, text, fallback, copyable, place]);
  useIsomorphicLayoutEffect(() => () => release?.(id), [id, release]);
  const owns = windowBar?.owner === id;
  const report = useContext(WindowBarOwnerReportContext);
  useIsomorphicLayoutEffect(() => {
    if (!report || !owns) return;
    report(true);
    return () => report(false);
  }, [report, owns]);
  return owns;
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined"
    ? (_effect: () => unknown, _deps: unknown[]) => {}
    : useLayoutEffect;
