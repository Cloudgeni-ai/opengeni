import { APPEARANCE_KEY } from "@opengeni/react/app/lib/appearance";
import {
  SIMPLIFIED_INTERFACE_KEY,
  SIMPLIFIED_INTERFACE_PARAMETER,
  interfaceProductName,
  parseSimplifiedInterface,
  storedSimplifiedInterfaceValue,
} from "@opengeni/react/app/lib/simplified-interface";

/**
 * Keep the simplified-interface flag a landing URL carries
 * (`?simplified_interface=1`, the address gogeni.ai and app.gogeni.ai send
 * people to) in this browser, then remove the parameter so it is not
 * bookmarked or shared with the page.
 *
 * The inline bootstrap in index.html applies the same rules before the first
 * paint; this repeats them for the router (which must not see the parameter)
 * and is where they are tested. Someone who arrives with the flag and no
 * appearance of their own gets the light look of the Geni site.
 */
export function retainLandingSimplifiedInterface(target: Window): boolean | null {
  try {
    const url = new URL(target.location.href);
    if (!url.searchParams.has(SIMPLIFIED_INTERFACE_PARAMETER)) return null;
    const named = parseSimplifiedInterface(url.searchParams.get(SIMPLIFIED_INTERFACE_PARAMETER));
    url.searchParams.delete(SIMPLIFIED_INTERFACE_PARAMETER);
    target.history.replaceState(
      target.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    if (named === null) return null;
    target.localStorage.setItem(SIMPLIFIED_INTERFACE_KEY, storedSimplifiedInterfaceValue(named));
    if (named && !target.localStorage.getItem(APPEARANCE_KEY)) {
      target.localStorage.setItem(APPEARANCE_KEY, "light");
    }
    return named;
  } catch {
    // The flag is presentation only and must never affect application boot.
    return null;
  }
}

/** Name the product in a page title the way the current interface does. */
export function interfacePageTitle(title: string, simplified: boolean): string {
  const pattern = new RegExp(`\\b${interfaceProductName(!simplified)}\\b`, "gu");
  return title.replace(pattern, interfaceProductName(simplified));
}

/** The simplified interface's page icon: the Geni tile (`public/geni-icon.svg`). */
export const SIMPLIFIED_INTERFACE_ICON = "/geni-icon.svg";

type IconLink = Pick<HTMLLinkElement, "getAttribute" | "setAttribute" | "removeAttribute">;

/**
 * Point the page's icons (`<link rel="icon">`, not the home-screen icon) at
 * the Geni tile while the simplified interface is on, and back at the
 * Opengeni files from index.html when it is off. Each link keeps its own
 * address and type, so turning the flag off restores exactly what was there.
 */
export function applyInterfaceIcons(
  doc: { querySelectorAll: (selector: string) => Iterable<IconLink> },
  simplified: boolean,
): void {
  for (const link of doc.querySelectorAll('link[rel="icon"]')) {
    const kept = link.getAttribute("data-og-icon-href");
    if (simplified) {
      if (kept === null) {
        link.setAttribute("data-og-icon-href", link.getAttribute("href") ?? "");
        link.setAttribute("data-og-icon-type", link.getAttribute("type") ?? "");
      }
      link.setAttribute("href", SIMPLIFIED_INTERFACE_ICON);
      link.setAttribute("type", "image/svg+xml");
    } else if (kept !== null) {
      const type = link.getAttribute("data-og-icon-type");
      link.setAttribute("href", kept);
      if (type) link.setAttribute("type", type);
      else link.removeAttribute("type");
      link.removeAttribute("data-og-icon-href");
      link.removeAttribute("data-og-icon-type");
    }
  }
}
