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
    const id = parts[editable ? 5 : 4];
    if (parts.length !== (editable ? 6 : 5) || !id || !UUID.test(id)) return null;
    return { id, editable };
  } catch {
    return null;
  }
}

export function artifactReturnSearch(search: Record<string, unknown>): { fromSession?: string } {
  return typeof search.fromSession === "string" && UUID.test(search.fromSession)
    ? { fromSession: search.fromSession }
    : {};
}
