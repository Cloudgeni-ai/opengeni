import { jsonError } from "./headers";
import type { SiteContext } from "./site-context";

/**
 * PR B EXTENSION POINT: optional per-Site Cloudflare storage.
 *
 * PR B binds `SITE_DB` (a SQLite-backed Durable Object namespace, one object
 * per Site via `idFromName(siteId)`) and serves two paths here:
 * - Site calls (`site.sql.run(name, params)`), reached through the ordinary
 *   `/_og/api` forwarding once the API authorizes them; and
 * - the API's agent tools, which call this internal route with an
 *   HMAC-signed request (same canonical string and secret as gateway -> API,
 *   verified here) and are proxied to the Site's Durable Object.
 *
 * PR A ships no storage: the route answers 404 while `SITE_DB` is unbound
 * and 501 if someone binds it before PR B lands.
 */
export const SITE_DB_INTERNAL_PREFIX = "/_og/internal/site-db";

export async function handleSiteDbInternal(site: SiteContext): Promise<Response> {
  const security = { noindex: true, hsts: site.hsts };
  if (!site.env.SITE_DB)
    return jsonError(404, { code: "not_found", message: "Not found" }, security);
  return jsonError(
    501,
    { code: "site_db_not_implemented", message: "Site database storage is not available yet" },
    security,
  );
}
