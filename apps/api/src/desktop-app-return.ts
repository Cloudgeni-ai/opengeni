import { OPENGENI_DESKTOP_APP_HEADER, desktopAppReturnPath } from "@opengeni/contracts";
import type { Context } from "hono";

/**
 * A sign-in started in the desktop app finishes in the person's own browser.
 * For a flow that returns to a console path, send that browser through the
 * console's hand-back page, which reopens the app on the same path with the
 * flow's outcome. Requests from anywhere else are unchanged.
 */
export function withDesktopAppReturnPath<T extends { returnPath?: string | undefined }>(
  c: Context,
  payload: T,
): T {
  if (!c.req.header(OPENGENI_DESKTOP_APP_HEADER) || payload.returnPath === undefined) {
    return payload;
  }
  return { ...payload, returnPath: desktopAppReturnPath(payload.returnPath) };
}
