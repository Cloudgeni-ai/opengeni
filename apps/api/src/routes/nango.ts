import type { Context, Hono } from "hono";
import type { Permission } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import { requireAccessContext, type ApiRouteDeps } from "@opengeni/core";
import { summarizeNangoUsage, withAccountRls } from "@opengeni/db";
import { requireSelectedAccount } from "./billing";
import { oauthCallbackBrowser } from "../integrations/oauth-browser-binding";
import {
  completeNangoConnect,
  handleNangoWebhook,
  NANGO_CONNECT_COMPLETE_PATH,
  NANGO_CONNECT_PATH,
  NANGO_WEBHOOK_PATH,
  nangoConnectPage,
} from "../integrations/nango-connect";

export const NANGO_USAGE_PATH = "/v1/billing/integration-usage";

const MAX_USAGE_PERIOD_MS = 366 * 24 * 60 * 60 * 1000;

function usagePeriod(query: { since?: string | undefined; until?: string | undefined }): {
  since: Date;
  until: Date;
} {
  const now = new Date();
  const until = query.until ? new Date(query.until) : now;
  const since = query.since
    ? new Date(query.since)
    : new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), 1));
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until)
    throw new HTTPException(400, {
      message: "since and until must be ISO times with since before until",
    });
  if (until.getTime() - since.getTime() > MAX_USAGE_PERIOD_MS)
    throw new HTTPException(400, { message: "usage periods are at most one year" });
  return { since, until };
}

/**
 * The organization a request names (or the caller's default one), when the
 * caller holds `permission` there or is its admin.
 */
export async function requireAccountPermission(
  c: Context,
  deps: ApiRouteDeps,
  requestedAccountId: string | undefined,
  permission: Permission,
): Promise<string> {
  const context = await requireAccessContext(c, deps);
  return requireSelectedAccount(context, requestedAccountId, permission);
}

/** Nango Connect, its webhook, and the organization's Nango usage (docs/nango.md). */
export function registerNangoRoutes(app: Hono, deps: ApiRouteDeps): void {
  const nangoDeps = { db: deps.db, settings: deps.settings };

  // Public: the signed state and its browser binding are the authority.
  app.get(NANGO_CONNECT_PATH, async (c) =>
    nangoConnectPage(nangoDeps, {
      state: c.req.query("state"),
      browser: await oauthCallbackBrowser(c, deps),
      requestUrl: c.req.url,
    }),
  );

  app.post(NANGO_CONNECT_COMPLETE_PATH, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { state?: unknown } | null;
    if (typeof body?.state !== "string" || body.state.length > 16384)
      throw new HTTPException(400, { message: "missing connection state" });
    const result = await completeNangoConnect(nangoDeps, {
      state: body.state,
      browser: await oauthCallbackBrowser(c, deps),
    });
    return c.json(
      result.status === "complete"
        ? { status: result.status, redirectTo: result.redirectTo }
        : { status: result.status },
    );
  });

  // Public: Nango's HMAC signature over the raw body is the authority.
  app.post(NANGO_WEBHOOK_PATH, async (c) => {
    const outcome = await handleNangoWebhook(nangoDeps, {
      rawBody: await c.req.text(),
      signature: c.req.header("x-nango-hmac-sha256"),
    });
    return c.json({ ok: true, outcome });
  });

  // Organization admins: estimated Nango usage and cost of their organization.
  app.get(NANGO_USAGE_PATH, async (c) => {
    const accountId = await requireAccountPermission(
      c,
      deps,
      c.req.query("accountId"),
      "billing:read",
    );
    const period = usagePeriod({ since: c.req.query("since"), until: c.req.query("until") });
    return c.json(
      await withAccountRls(deps.db, accountId, (scoped) =>
        summarizeNangoUsage(scoped, { ...period, accountId }),
      ),
    );
  });
}
