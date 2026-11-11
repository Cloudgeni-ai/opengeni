import type { Settings } from "@opengeni/config";

/**
 * Pluggable content scanning for published Sites. `none` is the default; the
 * Google Web Risk scanner runs only with OPENGENI_SITES_WEB_RISK_API_KEY. A
 * scan looks up the absolute URLs found in a Site's HTML when it is published
 * and records findings for moderation. It never blocks publishing, and a
 * disabled or failing scanner records nothing that blocks either.
 */

export type SiteContentScanFinding = { url: string; threatTypes: string[] };
export type SiteContentScanResult = {
  status: "none" | "clean" | "flagged" | "error";
  findings: SiteContentScanFinding[];
};

export type SiteContentScanner = {
  readonly name: "none" | "web_risk";
  scanHtml(html: string): Promise<SiteContentScanResult>;
};

/** Most distinct URLs one scan looks up (bounds cost per publish). */
export const SITE_SCAN_MAX_URLS = 20;

/** Distinct absolute http(s) URLs in the HTML, first seen first, at most `limit`. */
export function siteHtmlUrls(html: string, limit = SITE_SCAN_MAX_URLS): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>`()\\]{1,2000}/giu)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    found.add(url.toString());
    if (found.size >= limit) break;
  }
  return [...found];
}

export const noneSiteContentScanner: SiteContentScanner = Object.freeze({
  name: "none" as const,
  scanHtml: async () => ({ status: "none" as const, findings: [] }),
});

const WEB_RISK_THREATS = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"];

export function createWebRiskSiteContentScanner(
  apiKey: string,
  options: { fetch?: typeof fetch } = {},
): SiteContentScanner {
  const fetchImpl = options.fetch ?? fetch;
  return {
    name: "web_risk",
    async scanHtml(html) {
      const urls = siteHtmlUrls(html);
      if (urls.length === 0) return { status: "clean", findings: [] };
      const findings: SiteContentScanFinding[] = [];
      try {
        for (const url of urls) {
          const query = new URLSearchParams();
          for (const threat of WEB_RISK_THREATS) query.append("threatTypes", threat);
          query.set("uri", url);
          query.set("key", apiKey);
          const response = await fetchImpl(
            `https://webrisk.googleapis.com/v1/uris:search?${query.toString()}`,
            { method: "GET" },
          );
          if (!response.ok) throw new Error(`Web Risk lookup failed with ${response.status}`);
          const body = (await response.json().catch(() => ({}))) as {
            threat?: { threatTypes?: unknown };
          };
          const types = Array.isArray(body.threat?.threatTypes)
            ? body.threat.threatTypes.filter((type): type is string => typeof type === "string")
            : [];
          if (types.length > 0) findings.push({ url, threatTypes: types });
        }
      } catch {
        return { status: "error", findings };
      }
      return { status: findings.length > 0 ? "flagged" : "clean", findings };
    },
  };
}

export function createSiteContentScanner(
  settings: Pick<Settings, "sitesWebRiskApiKey">,
  options: { fetch?: typeof fetch } = {},
): SiteContentScanner {
  return settings.sitesWebRiskApiKey
    ? createWebRiskSiteContentScanner(settings.sitesWebRiskApiKey, options)
    : noneSiteContentScanner;
}
