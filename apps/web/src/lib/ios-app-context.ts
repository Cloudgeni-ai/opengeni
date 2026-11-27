const storageKey = "opengeni:ios-app-context";

/** Presentation only. Read at entry, before the router cleans route-specific search. */
export function readIosAppContext(browser: {
  location: Pick<Location, "pathname" | "search">;
  sessionStorage: Pick<Storage, "getItem" | "setItem">;
}): boolean {
  const { pathname, search } = browser.location;
  const params = new URLSearchParams(search);
  const marked =
    params.get("client") === "ios" ||
    ((pathname === "/native-sign-in" || pathname === "/native-sign-in/") &&
      params.get("platform") === "ios");
  try {
    if (marked) browser.sessionStorage.setItem(storageKey, "1");
    return marked || browser.sessionStorage.getItem(storageKey) === "1";
  } catch {
    // Storage can be blocked. Honor the explicit marker for this document anyway.
    return marked;
  }
}
