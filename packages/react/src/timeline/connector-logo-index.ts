/*
 * Which logo belongs to a connector domain. Tool steps and sign-in cards name
 * their connector by the domain of the connection or MCP server they used
 * (Linear's is mcp.linear.app), while the catalog files the logo under the
 * provider's own domain (linear.app). Indexing every domain a catalog entry is
 * known by lets any of them find the logo. Framework-neutral, so web, native
 * and embedded surfaces resolve logos the same way.
 */

/** The catalog fields that name a connector's domains and logo. */
export type ConnectorLogoSource = {
  providerDomain?: string | null | undefined;
  mcpUrl?: string | null | undefined;
  /** A workspace's own MCP server keeps its address here instead of `mcpUrl`. */
  endpointUrl?: string | null | undefined;
  connectionRef?: { providerDomain?: string | null | undefined } | null | undefined;
  logoAssetPath?: string | null | undefined;
};

/** "WWW.Linear.app " → "linear.app". */
export function normalizeConnectorDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

function urlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Every domain each catalog entry is known by, mapped to its logo URL. The
 * provider's own domain is claimed first across the whole catalog, so another
 * entry's server host never takes over a provider's logo.
 */
export function connectorLogoIndex(
  catalog: readonly ConnectorLogoSource[],
  logoUrl: (logoAssetPath: string | null | undefined) => string | null | undefined,
): ReadonlyMap<string, string> {
  const logos = new Map<string, string>();
  const entries = catalog.flatMap((item) => {
    const url = logoUrl(item.logoAssetPath);
    return url ? [{ item, url }] : [];
  });
  const claim = (domain: string | null | undefined, url: string) => {
    if (!domain) return;
    const key = normalizeConnectorDomain(domain);
    if (key && !logos.has(key)) logos.set(key, url);
  };
  for (const { item, url } of entries) claim(item.providerDomain, url);
  for (const { item, url } of entries) {
    claim(item.connectionRef?.providerDomain, url);
    claim(urlHost(item.mcpUrl), url);
  }
  for (const { item, url } of entries) claim(urlHost(item.endpointUrl), url);
  return logos;
}

/** The logo for a connector domain from an index built by `connectorLogoIndex`. */
export function connectorLogo(
  index: ReadonlyMap<string, string>,
  domain: string | null | undefined,
): string | null {
  return domain ? (index.get(normalizeConnectorDomain(domain)) ?? null) : null;
}
