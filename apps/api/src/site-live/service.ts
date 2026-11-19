import { createHmac, timingSafeEqual } from "node:crypto";
import { HTML_FRAME_HOST_LABEL } from "@opengeni/contracts/html-frame-host";
import {
  SITE_GATEWAY_LIVE_PATH,
  SITE_LIVE_TTL_SECONDS,
  normalizeSitesDomain,
  siteLiveInternalPath,
  type SiteLiveNotice,
} from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import type { SiteDataChange, SiteDataChangeListener } from "@opengeni/db";
import { signGatewayInternalRequest, siteSqlGatewayConfig } from "../site-sql/gateway";

/**
 * Live change hints (docs/site-data.md, "Change events"). After a Site Data
 * transaction commits while the Site is watched, and after a publish or
 * rollback, the API tells the gateway's per-Site live object over the signed
 * internal route `POST /_og/internal/site-live/<siteId>`; the object passes
 * only collection names and change numbers (or the new version) to the open
 * connections that may read them. Pages then refetch through their normal,
 * authorized calls. Hints are best effort: a lost notice only delays a page
 * until its next refetch or fallback poll, so nothing here ever fails or
 * delays the write that caused it.
 */

export type SiteLiveSettings = Pick<
  Settings,
  "sitesGatewayInternalOrigin" | "sitesGatewaySecret" | "sitesSqlTimeoutMs" | "sitesDomain"
> &
  Partial<Pick<Settings, "sitesCloudflareStorageEnabled">>;

/** Notices are small and best effort: give up quickly. */
const NOTICE_TIMEOUT_MS = 3_000;

export type SiteLiveFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Whether this deployment can send live hints (the gateway's internal route is configured). */
export function siteLiveConfigured(settings: SiteLiveSettings): boolean {
  return Boolean(settings.sitesGatewayInternalOrigin && settings.sitesGatewaySecret);
}

/** Send one notice to a Site's live connections. Never throws; resolves when sent or given up. */
export async function sendSiteLiveNotice(
  settings: SiteLiveSettings,
  siteId: string,
  notice: SiteLiveNotice,
  fetchImpl: SiteLiveFetch = fetch,
): Promise<boolean> {
  if (!siteLiveConfigured(settings)) return false;
  try {
    const config = siteSqlGatewayConfig({
      sitesCloudflareStorageEnabled: settings.sitesCloudflareStorageEnabled ?? false,
      sitesGatewayInternalOrigin: settings.sitesGatewayInternalOrigin,
      sitesGatewaySecret: settings.sitesGatewaySecret,
      sitesSqlTimeoutMs: settings.sitesSqlTimeoutMs,
    });
    if (!config) return false;
    const body = JSON.stringify(notice);
    const signed = signGatewayInternalRequest(config, siteLiveInternalPath(siteId), body);
    const response = await fetchImpl(signed.url, {
      method: "POST",
      headers: signed.headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/** Fire-and-forget form of sendSiteLiveNotice. */
export function notifySiteLive(
  settings: SiteLiveSettings,
  siteId: string,
  notice: SiteLiveNotice,
  fetchImpl: SiteLiveFetch = fetch,
): void {
  void sendSiteLiveNotice(settings, siteId, notice, fetchImpl);
}

/** The Site Data store's change listener for this deployment, or undefined without a gateway. */
export function siteLiveChangeListener(
  settings: SiteLiveSettings,
  fetchImpl: SiteLiveFetch = fetch,
): SiteDataChangeListener | undefined {
  if (!siteLiveConfigured(settings)) return undefined;
  return (change: SiteDataChange) =>
    notifySiteLive(
      settings,
      change.siteId,
      { type: "data", seq: change.seq, collections: change.collections.slice(0, 200) },
      fetchImpl,
    );
}

// ---------------------------------------------------------------------------
// Console tickets
// ---------------------------------------------------------------------------

/** A console ticket is good for opening one connection within this long. */
export const SITE_LIVE_TICKET_SECONDS = 60;
const TICKET_CONTEXT = "OGLIVE1";

/**
 * What a console ticket admits: one Site, the collections its holder may
 * read (null: all), the change number when it was issued and how long the
 * connection may stay open.
 */
export type SiteLiveTicket = {
  siteId: string;
  collections: string[] | null;
  seq: number;
  /** Unix seconds after which the ticket opens nothing. */
  expiresAt: number;
  ttlSeconds: number;
};

function ticketMac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`${TICKET_CONTEXT}\n${payload}`).digest("base64url");
}

/** `v1.<payload>.<mac>`: the gateway verifies it with the same gateway secret. */
export function createSiteLiveTicket(secret: string, ticket: SiteLiveTicket): string {
  const payload = Buffer.from(
    JSON.stringify({
      s: ticket.siteId,
      c: ticket.collections,
      q: ticket.seq,
      e: ticket.expiresAt,
      t: ticket.ttlSeconds,
    }),
  ).toString("base64url");
  return `v1.${payload}.${ticketMac(secret, payload)}`;
}

/** Verify a ticket (tests and parity with the gateway). Null when invalid or expired. */
export function verifySiteLiveTicket(
  secrets: readonly (string | null | undefined)[],
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): SiteLiveTicket | null {
  const [version, payload, mac] = token.split(".");
  if (version !== "v1" || !payload || !mac) return null;
  const valid = secrets.some((secret) => {
    if (!secret) return false;
    const expected = Buffer.from(ticketMac(secret, payload));
    const received = Buffer.from(mac);
    return expected.length === received.length && timingSafeEqual(expected, received);
  });
  if (!valid) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      s: string;
      c: string[] | null;
      q: number;
      e: number;
      t: number;
    };
    if (parsed.e < nowSeconds) return null;
    return {
      siteId: parsed.s,
      collections: parsed.c,
      seq: parsed.q,
      expiresAt: parsed.e,
      ttlSeconds: parsed.t,
    };
  } catch {
    return null;
  }
}

/** `wss://og.<sites domain>/_og/live`, or null when the deployment has no HTTPS Sites domain. */
export function siteLiveConsoleUrl(settings: Pick<Settings, "sitesDomain">): string | null {
  if (!settings.sitesDomain) return null;
  let domain: string;
  try {
    domain = normalizeSitesDomain(settings.sitesDomain);
  } catch {
    return null;
  }
  if (domain === "localhost" || domain.endsWith(".localhost")) return null;
  return `wss://${HTML_FRAME_HOST_LABEL}.${domain}${SITE_GATEWAY_LIVE_PATH}`;
}

export { SITE_LIVE_TTL_SECONDS };
