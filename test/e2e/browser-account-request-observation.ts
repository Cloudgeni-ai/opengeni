import type { Page, Route } from "playwright";

/** Preserve Chromium request headers before a deliberate document-replacement race. */
export async function observeChromiumNeutralSessionSetRequestAuthority(
  page: Page,
  origin: string,
): Promise<() => Promise<void>> {
  // This is a Chromium observation seam, not a portable cookie-access API.
  // Other engines keep their ordinary request lifecycle and the same strict
  // failure/quiescence ledger; missing authority must still fail closed.
  if (page.context().browser()?.browserType().name() !== "chromium") return async () => {};
  const matches = (url: URL) => url.origin === origin && url.pathname === "/v1/auth/session-set";
  // Chromium normally attaches full headers only once response metadata arrives.
  // A destroyed document can leave neither that metadata nor a terminal event.
  // Native pass-through interception supplies the actual request's headers at
  // dispatch; never substitute the context's later cookie or infer authority.
  const forward = (route: Route) => route.continue();
  await page.route(matches, forward);
  return () => page.unroute(matches, forward);
}
