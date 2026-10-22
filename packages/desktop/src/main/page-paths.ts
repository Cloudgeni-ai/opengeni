// Which product web pages the app reopens. Pure, so tests reach it without Electron.
import type { AppWebPaths } from "@opengeni/sdk/app-links";

/** The path a person was on, when it is one the app reopens: any page `match` recognizes. */
export function reopenablePath(
  url: string,
  paths: AppWebPaths,
): { path: string; workspaceId: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(parsed.protocol)) return null;
  const page = paths.match(parsed.pathname, parsed.search);
  return page ? { path: parsed.pathname, workspaceId: page.workspaceId } : null;
}
