/**
 * The browser page a sign-in started in the desktop app lands on once the
 * provider is done (`/desktop-return?url=…`): it hands the person back to the
 * app, which already shows the finished connection.
 */
import { openInAppUrl } from "@/lib/open-in-app";

/**
 * The console page the flow meant to return to, or null when the link is
 * missing it or names another site. The destination is a full console URL or
 * a console path. A provider may add its own outcome parameters to the
 * hand-back link; they are carried onto that page.
 */
export function desktopReturnTarget(search: string, origin: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get("url");
  if (!raw) return null;
  let target: URL;
  try {
    target = new URL(raw, origin);
  } catch {
    return null;
  }
  if (target.origin !== origin) return null;
  for (const [key, value] of params) {
    if (key !== "url") target.searchParams.append(key, value);
  }
  return target.toString();
}

/** The link that opens `target` in the desktop app. */
export function desktopReturnAppLink(target: string): string {
  return openInAppUrl(target);
}
