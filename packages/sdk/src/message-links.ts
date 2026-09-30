/**
 * Links an agent writes into chat Markdown that point at OpenGeni-owned objects.
 *
 * Agents write these forms (tool receipts and bundled Skills teach them):
 *
 * - `artifact:<file uuid>` — a retained workspace file (exports, published files, images).
 * - `sandbox:<path>[:<line>]` — a file in the session's sandbox or Connected Machine.
 * - `/workspaces/<ws>/artifacts/editable/<32-hex id>` — a live editable document,
 *   workbook, or presentation.
 * - `/workspaces/<ws>/artifacts/<uuid>` — a saved Site / published HTML artifact.
 * - `/workspaces/<ws>/artifacts/files/<uuid>` — a retained file (console path form).
 *
 * None of them is a URL a browser can navigate on its own: the `/workspaces/...`
 * forms are OpenGeni console routes, so inside another product they resolve
 * against that product's origin and 404. Parse them with {@link parseOpenGeniLink}
 * and route each target to the host's own UI (download, panel, page).
 */
export type OpenGeniLinkTarget =
  | { kind: "file"; fileId: string; workspaceId: string | null }
  | { kind: "editable-artifact"; artifactId: string; workspaceId: string }
  | { kind: "site"; artifactId: string; workspaceId: string }
  | { kind: "sandbox-file"; path: string; line: number | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EDITABLE_ID = /^[0-9a-f]{32}$/iu;
const WORKSPACE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SANDBOX_SCHEME = "sandbox:";
const LEGACY_WORKSPACE_PREFIX = "/workspace/";
const TRAILING_LINE = /:([0-9]+)$/u;
const TRAILING_INVALID_LINE = /:-(?:[0-9]+)$|:[0-9]+-[0-9]+$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/**
 * Parse an OpenGeni `sandbox:` href (plus the historical bare `/workspace/...`
 * form). The decoded path is intentionally opaque: target selection, path
 * policy, and filesystem authority belong to the session-aware host.
 */
export function parseSandboxLink(
  href: string | undefined,
): { path: string; line: number | null } | null {
  if (!href) return null;
  const encodedLocation = href.startsWith(SANDBOX_SCHEME)
    ? href.slice(SANDBOX_SCHEME.length)
    : href.startsWith(LEGACY_WORKSPACE_PREFIX)
      ? href
      : null;
  if (!encodedLocation || encodedLocation.includes("?") || encodedLocation.includes("#")) {
    return null;
  }
  if (TRAILING_INVALID_LINE.test(encodedLocation)) return null;
  const lineMatch = TRAILING_LINE.exec(encodedLocation);
  const encodedPath = lineMatch ? encodedLocation.slice(0, -lineMatch[0].length) : encodedLocation;
  const line = lineMatch?.[1] ? Number(lineMatch[1]) : null;
  if (line !== null && (!Number.isSafeInteger(line) || line < 1)) return null;
  if (!encodedPath) return null;
  try {
    const path = decodeURIComponent(encodedPath);
    return path && !CONTROL_CHARACTER.test(path) ? { path, line } : null;
  } catch {
    return null;
  }
}

/** Return the retained-file id of an exact `artifact:<uuid>` reference. */
export function parseRetainedFileReference(href: string | undefined): string | null {
  if (!href?.startsWith("artifact:")) return null;
  const id = href.slice("artifact:".length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/**
 * Classify an agent-authored Markdown href. Returns `null` for ordinary links
 * (`https://…`, `mailto:`, relative host links), which render as-is.
 *
 * Only root-relative console paths are recognized; an absolute URL is always an
 * ordinary link, so a host's own `https://` routes are never reinterpreted.
 * A `?fromSession=<uuid>` return hint is accepted and ignored.
 */
export function parseOpenGeniLink(href: string | undefined): OpenGeniLinkTarget | null {
  if (!href) return null;
  const fileId = parseRetainedFileReference(href);
  if (fileId) return { kind: "file", fileId, workspaceId: null };
  if (href.startsWith(SANDBOX_SCHEME) || href.startsWith(LEGACY_WORKSPACE_PREFIX)) {
    const location = parseSandboxLink(href);
    return location ? { kind: "sandbox-file", ...location } : null;
  }
  if (!href.startsWith("/workspaces/") || href.includes("#")) return null;
  const [pathname = "", search] = href.split("?", 2) as [string, string | undefined];
  if (search !== undefined) {
    const params = new URLSearchParams(search);
    const keys = [...params.keys()];
    if (keys.some((key) => key !== "fromSession") || keys.length > 1) return null;
    if (!UUID.test(params.get("fromSession") ?? "")) return null;
  }
  const parts = pathname.split("/");
  const workspaceId = parts[2] ?? "";
  if (parts[1] !== "workspaces" || parts[3] !== "artifacts" || !WORKSPACE_SEGMENT.test(workspaceId))
    return null;
  if (parts.length === 6 && parts[4] === "editable" && EDITABLE_ID.test(parts[5] ?? "")) {
    return { kind: "editable-artifact", artifactId: parts[5]!.toLowerCase(), workspaceId };
  }
  if (parts.length === 6 && parts[4] === "files" && UUID.test(parts[5] ?? "")) {
    return { kind: "file", fileId: parts[5]!.toLowerCase(), workspaceId };
  }
  if (parts.length === 5 && UUID.test(parts[4] ?? "")) {
    return { kind: "site", artifactId: parts[4]!.toLowerCase(), workspaceId };
  }
  return null;
}

/** The OpenGeni console route for a target (the form agents write). */
export function openGeniConsolePath(
  target: OpenGeniLinkTarget,
  workspaceId: string,
): string | null {
  const workspace = encodeURIComponent(
    target.kind === "sandbox-file" ? workspaceId : (target.workspaceId ?? workspaceId),
  );
  switch (target.kind) {
    case "file":
      return `/workspaces/${workspace}/artifacts/files/${target.fileId}`;
    case "editable-artifact":
      return `/workspaces/${workspace}/artifacts/editable/${target.artifactId}`;
    case "site":
      return `/workspaces/${workspace}/artifacts/${target.artifactId}`;
    case "sandbox-file":
      return null;
  }
}
