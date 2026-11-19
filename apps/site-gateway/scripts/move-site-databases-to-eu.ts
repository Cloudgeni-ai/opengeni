#!/usr/bin/env bun
/**
 * Move Site SQL databases that were created before databases lived in the EU
 * (docs/site-data.md, "Location"). A database moves the first time it is
 * used; this uses the ones that are not being used (a read-only `inspect`
 * call, whose first use copies the database to the EU), so every database
 * moves without waiting for traffic. It is safe to run again: a database
 * already in the EU is left as it is.
 *
 *   OPENGENI_SITES_GATEWAY_INTERNAL_ORIGIN=https://internal.<sites domain> \
 *   OPENGENI_SITES_GATEWAY_SECRET=... \
 *   bun apps/site-gateway/scripts/move-site-databases-to-eu.ts <siteId>... (or one id per line on stdin)
 *
 * The ids are every `site_sql_databases.site_id`; that table has row-level
 * security, so list them as the table owner (the migrations role), for
 * example `psql "$MIGRATIONS_DATABASE_URL" -Atc 'select site_id from site_sql_databases'`.
 * Prints one line per Site
 * (`eu`, or `legacy` with the reason it could not move yet) and exits 1 when
 * any Site is not in the EU. Never deletes anything.
 */
import { createHash, createHmac } from "node:crypto";
import {
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_SIGNATURE_VERSION,
  SITE_GATEWAY_TIMESTAMP_HEADER,
  siteDbInternalPath,
  siteGatewayCanonicalString,
} from "@opengeni/contracts";
import { SITE_DB_LOCATION_HEADER, SITE_DB_RELOCATION_ERROR_HEADER } from "../src/site-db-location";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type MoveResult = {
  siteId: string;
  status: number;
  location: string | null;
  error: string | null;
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** One Site's copy runs inside its request; give a large one time, but never hang. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Touch each Site's database once through the gateway's signed internal route. */
export async function moveSiteDatabases(options: {
  origin: string;
  secret: string;
  siteIds: readonly string[];
  fetch?: Fetch;
}): Promise<MoveResult[]> {
  const fetchImpl = options.fetch ?? fetch;
  const results: MoveResult[] = [];
  for (const siteId of options.siteIds) {
    if (!UUID.test(siteId)) {
      results.push({ siteId, status: 0, location: null, error: "not a lowercase Site id" });
      continue;
    }
    const url = new URL(siteDbInternalPath(siteId, "inspect"), options.origin);
    const body = JSON.stringify({ requestId: crypto.randomUUID(), migrationsOnly: true });
    const timestamp = Math.floor(Date.now() / 1000);
    const canonical = siteGatewayCanonicalString({
      method: "POST",
      host: url.host,
      pathWithQuery: url.pathname,
      timestamp,
      bodySha256: createHash("sha256").update(body).digest("hex"),
      session: "",
      visitor: "",
      clientIp: "",
      human: "",
    });
    const mac = createHmac("sha256", options.secret).update(canonical).digest("base64url");
    try {
      const response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SITE_GATEWAY_TIMESTAMP_HEADER]: String(timestamp),
          [SITE_GATEWAY_SIGNATURE_HEADER]: `${SITE_GATEWAY_SIGNATURE_VERSION}=${mac}`,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      let message: string | null = response.headers.get(SITE_DB_RELOCATION_ERROR_HEADER);
      if (!response.ok) {
        try {
          message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
        } catch {
          message = text.slice(0, 300);
        }
      }
      results.push({
        siteId,
        status: response.status,
        location: response.headers.get(SITE_DB_LOCATION_HEADER),
        error: message,
      });
    } catch (error) {
      results.push({ siteId, status: 0, location: null, error: String(error) });
    }
  }
  return results;
}

if (import.meta.main) {
  const origin = process.env.OPENGENI_SITES_GATEWAY_INTERNAL_ORIGIN;
  const secret = process.env.OPENGENI_SITES_GATEWAY_SECRET;
  if (!origin || !secret) {
    console.error(
      "Set OPENGENI_SITES_GATEWAY_INTERNAL_ORIGIN and OPENGENI_SITES_GATEWAY_SECRET (as the API has them).",
    );
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const siteIds = (args.length > 0 ? args : (await Bun.stdin.text()).split(/\s+/u))
    .map((id) => id.trim())
    .filter(Boolean);
  if (siteIds.length === 0) {
    // An empty list is a mistake (for example a query that row-level security filtered), not success.
    console.error("No Site ids given.");
    process.exit(2);
  }
  const results = await moveSiteDatabases({ origin, secret, siteIds });
  for (const result of results)
    console.log(
      [result.siteId, result.status, result.location ?? "-", result.error ?? ""].join("\t"),
    );
  const notMoved = results.filter((result) => result.status !== 200 || result.location !== "eu");
  console.log(
    `${results.length - notMoved.length} of ${results.length} Site databases are in the EU.`,
  );
  process.exit(notMoved.length > 0 ? 1 : 0);
}
