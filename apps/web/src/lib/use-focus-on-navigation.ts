import { useEffect, useRef } from "react";

/**
 * Focus for pages that open in place of a list (settings sub-pages, detail and
 * form pages). After a real change of `pageKey`, focus lands on the new page's
 * title so keyboard and screen reader users start at the top of it; back on
 * the list, focus returns to the row that was opened.
 *
 * `onList` says the new page is the list. `rememberTitle` says the current page
 * is an object's page whose title names its row on the list.
 */
export function useFocusOnNavigation(
  pageKey: string,
  { onList, rememberTitle }: { onList: boolean; rememberTitle: boolean },
) {
  const ref = useRef<HTMLDivElement>(null);
  const previousKey = useRef(pageKey);
  const lastTitle = useRef<string | null>(null);
  useEffect(() => {
    const root = ref.current;
    // Strict mode runs effects twice; only a real change of page moves focus.
    if (previousKey.current !== pageKey && root) {
      previousKey.current = pageKey;
      const returnTo = lastTitle.current;
      const row =
        onList && returnTo !== null
          ? Array.from(root.querySelectorAll<HTMLElement>("[data-slot=list-row]")).find((each) =>
              each.textContent?.includes(returnTo),
            )
          : undefined;
      if (row) {
        row.querySelector<HTMLElement>("[data-row-action]")?.focus();
      } else {
        const heading = root.querySelector<HTMLElement>("h1");
        if (heading) {
          if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
          // A heading is not a control: no ring, but screen readers start here.
          heading.style.outline = "none";
          heading.focus({ preventScroll: true });
        }
        // A page opened from far down the list starts at its top; one already
        // in view stays put, so the back link doesn't jump under the frame edge.
        if (!onList && root.getBoundingClientRect().top < 0) {
          root.scrollIntoView?.({ block: "start" });
        }
      }
    }
    if (rememberTitle) {
      const title = root?.querySelector<HTMLElement>("h1")?.textContent;
      if (title) lastTitle.current = title;
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only when the page changes
  }, [pageKey]);
  return ref;
}
