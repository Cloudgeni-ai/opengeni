import type { Context } from "hono";

/**
 * The Clear-Site-Data value sent when someone signs out of Opengeni (CASA
 * 6.6.1). Only the HTTP cache is cleared:
 *
 * - "cookies" would also sign the browser out of every other site sharing the
 *   registrable domain, including products that embed Opengeni.
 * - "storage" would also delete this origin's IndexedDB, which holds meeting
 *   recordings that have not finished uploading, and the session entry that
 *   carries an organization invitation across a change of account. The web
 *   app instead clears its own per-person session storage on sign-out.
 */
export const SIGN_OUT_CLEAR_SITE_DATA = '"cache"';

/** Add Clear-Site-Data to a successful sign-out response. */
export async function clearSiteDataOnSignOut(
  context: Context,
  next: () => Promise<void>,
): Promise<void> {
  await next();
  if (context.req.method !== "POST" || !context.res.ok) return;
  // Provider responses can carry immutable headers; copy before adding one.
  const response = new Response(context.res.body, context.res);
  response.headers.set("clear-site-data", SIGN_OUT_CLEAR_SITE_DATA);
  context.res = response;
}
