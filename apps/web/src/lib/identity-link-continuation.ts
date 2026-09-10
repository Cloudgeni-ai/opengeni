type IdentityLinkContinuation = { linkId: string; organizationId: string; challenge: string };
let retained: IdentityLinkContinuation | null = null;

export function parseIdentityLinkContinuation(url: URL): IdentityLinkContinuation | null {
  const match = /\/identity-links\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
  const organizationId = url.searchParams.get("organization");
  const challenge = new URLSearchParams(url.hash.slice(1)).get("challenge");
  if (
    !match ||
    !organizationId ||
    !/^[0-9a-f-]{36}$/i.test(organizationId) ||
    !challenge ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge)
  )
    return null;
  return { linkId: match[1]!, organizationId, challenge };
}

/** Run before React/auth/analytics mount. The challenge lives only in this tab's
 * module memory; reload requires reopening the original host request. */
export function retainIdentityLinkContinuation(target: Pick<Window, "location" | "history">): void {
  const url = new URL(target.location.href);
  retained = parseIdentityLinkContinuation(url);
  if (/\/identity-links\//.test(url.pathname) && url.hash)
    target.history.replaceState(target.history.state, "", url.pathname + url.search);
}

export function readIdentityLinkContinuation(
  linkId: string,
  organizationId: string | undefined,
): string | null {
  return retained?.linkId === linkId && retained.organizationId === organizationId
    ? retained.challenge
    : null;
}
