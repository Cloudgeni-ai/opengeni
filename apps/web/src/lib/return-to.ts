/* ----------------------------------------------------------------------------
   Back returns where you came from. A link that crosses into another scope
   (a workspace's settings -> organization settings, or back) carries its
   origin in the URL, so the destination's back link can say "Design preview ·
   Models" and return there instead of to its own parent:

     ?from=/workspaces/<id>/settings?section=models&fromLabel=Design preview · Models

   Without these params a page's back link goes to its own parent as usual.
   -------------------------------------------------------------------------- */

export interface ReturnTo {
  /** A same-origin in-app path, with its search: "/workspaces/<id>/settings?section=models". */
  path: string;
  /** What the back link says: "Design preview · Models". */
  label: string;
}

/** The search params a cross-scope link adds. */
export interface ReturnToSearch {
  from?: string;
  fromLabel?: string;
}

const MAX_PATH = 512;
const MAX_LABEL = 80;
const BASE = "https://in-app.invalid";

/**
 * Accepts only a path inside this app: it starts with one "/", has no scheme,
 * host, backslash or control character, and resolves to the same origin.
 */
export function safeInAppPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH) {
    return undefined;
  }
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== BASE) return undefined;
  return `${url.pathname}${url.search}`;
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // oxlint-disable-next-line no-control-regex -- labels are plain text
  const label = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return label && label.length <= MAX_LABEL ? label : undefined;
}

/** Reads `from` + `fromLabel` from a route's raw search; both or nothing. */
export function parseReturnTo(search: Record<string, unknown>): ReturnToSearch {
  const from = safeInAppPath(search.from);
  const fromLabel = safeLabel(search.fromLabel);
  return from && fromLabel ? { from, fromLabel } : {};
}

export function returnToOf(search: ReturnToSearch): ReturnTo | undefined {
  return search.from && search.fromLabel
    ? { path: search.from, label: search.fromLabel }
    : undefined;
}

export function returnToSearch(returnTo: ReturnTo | undefined): ReturnToSearch {
  return returnTo ? { from: returnTo.path, fromLabel: returnTo.label } : {};
}

/** The page being viewed right now, as a return target. */
export function currentPageReturnTo(label: string): ReturnTo | undefined {
  if (typeof window === "undefined") return undefined;
  const path = safeInAppPath(`${window.location.pathname}${window.location.search}`);
  return path ? { path, label } : undefined;
}
