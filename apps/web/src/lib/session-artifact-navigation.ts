const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Only canonical, same-origin/workspace artifact links belong in the session dock. */
export function sessionArtifactFromHref(href: string, origin: string, workspaceId: string) {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || url.search || url.hash || url.username || url.password)
      return null;
    const parts = url.pathname.split("/");
    if (parts[1] !== "workspaces" || parts[2] !== workspaceId || parts[3] !== "artifacts")
      return null;
    const editable = parts[4] === "editable";
    const kind = parts[4] === "files" ? ("file" as const) : undefined;
    const nested = editable || kind !== undefined;
    const id = parts[nested ? 5 : 4];
    if (parts.length !== (nested ? 6 : 5) || !id || !UUID.test(id)) return null;
    return { id, editable, ...(kind ? { kind } : {}) };
  } catch {
    return null;
  }
}
