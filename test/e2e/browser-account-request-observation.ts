import type { Page, Route } from "playwright";

/** Preserve native request headers before a deliberate document-replacement race. */
export async function observeNeutralSessionSetRequestAuthority(
  page: Page,
  origin: string,
): Promise<() => Promise<void>> {
  const matches = (url: URL) => url.origin === origin && url.pathname === "/v1/auth/session-set";
  // Chromium normally attaches full headers only once response metadata arrives.
  // A destroyed document can leave neither that metadata nor a terminal event.
  // Native pass-through interception supplies the actual request's headers at
  // dispatch; never substitute the context's later cookie or infer authority.
  const forward = (route: Route) => route.continue();
  await page.route(matches, forward);
  return () => page.unroute(matches, forward);
}
