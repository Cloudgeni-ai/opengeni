/**
 * Marks for services the catalog lists without one (its import fell back to a
 * generic monogram). Kept tiny and inline so no host has to serve files.
 */
const svg = (markup: string) => `data:image/svg+xml,${encodeURIComponent(markup)}`;

export const GOOGLE_DRIVE_LOGO = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 87.3 78">' +
    '<path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"/>' +
    '<path fill="#00ac47" d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z"/>' +
    '<path fill="#ea4335" d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"/>' +
    '<path fill="#00832d" d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"/>' +
    '<path fill="#2684fc" d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"/>' +
    '<path fill="#ffba00" d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"/>' +
    "</svg>",
);

const BY_HOST: Readonly<Record<string, string>> = {
  "drivemcp.googleapis.com": GOOGLE_DRIVE_LOGO,
};

/** A bundled mark for a catalog row whose own logo is missing. */
export function bundledLogo(item: { mcpUrl?: string | null; providerDomain?: string | null }) {
  for (const value of [item.mcpUrl, item.providerDomain]) {
    if (!value) continue;
    try {
      const host = new URL(value.includes("://") ? value : `https://${value}`).hostname;
      if (BY_HOST[host]) return BY_HOST[host];
    } catch {
      // Not a URL; keep looking.
    }
  }
  return null;
}
