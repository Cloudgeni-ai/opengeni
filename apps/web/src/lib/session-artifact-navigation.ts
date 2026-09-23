const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EDITABLE_ID = /^[0-9a-f]{32}$/iu;

/** Only canonical, same-origin/workspace artifact links belong in the session dock. */
export function sessionArtifactFromHref(href: string, origin: string, workspaceId: string) {
  if (href.startsWith("artifact:")) {
    const id = href.slice("artifact:".length);
    return UUID.test(id) ? { id: id.toLowerCase(), editable: false, kind: "file" as const } : null;
  }
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || url.hash || url.username || url.password) return null;
    // Return context does not change the selected artifact. Version/download parameters do.
    for (const [key, value] of url.searchParams) {
      if (key !== "fromSession" || !UUID.test(value)) return null;
    }
    if (url.searchParams.getAll("fromSession").length > 1) return null;
    const parts = url.pathname.split("/");
    if (parts[1] !== "workspaces" || parts[2] !== workspaceId || parts[3] !== "artifacts")
      return null;
    const editable = parts[4] === "editable";
    const kind = parts[4] === "files" ? ("file" as const) : undefined;
    const nested = editable || kind !== undefined;
    const id = parts[nested ? 5 : 4];
    if (parts.length !== (nested ? 6 : 5) || !id) return null;
    if (!(editable ? EDITABLE_ID.test(id) : UUID.test(id))) return null;
    return { id, editable, ...(kind ? { kind } : {}) };
  } catch {
    return null;
  }
}
