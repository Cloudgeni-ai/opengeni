/** Fragment tokens stay out of route searches and are removed only after a confirmed action. */
export function teamsFragmentToken(
  hash: string,
  kind: "teams_setup" | "teams_link",
): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const values = params.getAll(kind);
  const token = values.length === 1 ? values[0] : null;
  return token && token.length <= 16_384 && !/\s/.test(token) ? token : null;
}

export function teamsAuthReturnPath(
  location: Pick<Location, "pathname" | "search" | "hash">,
): string | null {
  if (location.pathname === "/teams/connect") {
    return `${location.pathname}${location.search}${location.hash}`;
  }
  if (
    /^\/workspaces\/[^/]+\/plugins\/?$/.test(location.pathname) &&
    teamsFragmentToken(location.hash, "teams_link")
  ) {
    return `${location.pathname}${location.search}${location.hash}`;
  }
  return null;
}

export function clearTeamsFragment(kind: "teams_setup" | "teams_link") {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  params.delete(kind);
  url.hash = params.toString();
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
