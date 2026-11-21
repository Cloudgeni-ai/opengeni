import { SITE_FRAME_HEADER } from "@opengeni/contracts/site-session-http";
import { APP_WEBHOOK_BODY_MAX_BYTES, type Permission } from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import { SiteDataError } from "@opengeni/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { notifyFromApp } from "../app-notify/service";
import {
  createAppWebhook,
  deleteAppWebhook,
  listAppWebhooks,
  receiveAppWebhook,
  updateAppWebhook,
} from "../app-webhooks/service";
import { readBoundedRawBody } from "../http/request-body";
import type { SiteDataSurface } from "../site-data/service";
import { siteDataHttpError } from "./site-data";

const Id = z.string().uuid();

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SiteDataError) throw siteDataHttpError(error);
    throw error;
  }
}

function param(context: Context, name: string, what: string): string {
  const parsed = Id.safeParse(context.req.param(name));
  if (!parsed.success) throw siteDataHttpError(new SiteDataError("not_found", `${what} not found`));
  return parsed.data;
}

function surface(context: Context): SiteDataSurface {
  const frame = context.req.header("x-opengeni-site-id");
  const marked = context.req.header(SITE_FRAME_HEADER) !== undefined;
  if (!frame && !marked) return {};
  return { frameSiteId: frame ?? "" };
}

/**
 * Webhooks into apps (docs/app-webhooks.md) and notifications from apps.
 * Under `/v1/workspaces/:workspaceId/published-artifacts/:artifactId`:
 *
 * - `GET|POST /webhooks`, `PATCH|DELETE /webhooks/:webhookId`: the app's
 *   managers (`artifacts:publish`), outside the app's frame. Create and
 *   rotate return the secret once.
 * - `POST /notify`: `site.notify` from the app's page in the console.
 *
 * And the public intake, `POST /v1/webhooks/apps/:workspaceId/:webhookId`,
 * authenticated by the webhook's secret (bearer or signature).
 */
export function registerAppWebhookRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/published-artifacts/:artifactId";
  const grantFor = async (context: Context, permission: Permission) =>
    await requireAccessGrant(context, deps, context.req.param("workspaceId")!, permission);
  const managed = (context: Context) => {
    if (surface(context).frameSiteId !== undefined)
      throw siteDataHttpError(
        new SiteDataError(
          "forbidden",
          "Webhooks are managed from Opengeni, not from inside the app",
        ),
      );
  };
  const json = async (context: Context) => await context.req.json().catch(() => null);

  app.get(`${base}/webhooks`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    managed(context);
    context.header("cache-control", "no-store");
    return context.json({
      webhooks: await run(() =>
        listAppWebhooks(deps, grant, param(context, "artifactId", "App"), context.req.url),
      ),
    });
  });

  app.post(`${base}/webhooks`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    managed(context);
    const body = await json(context);
    context.header("cache-control", "no-store");
    return context.json(
      await run(() =>
        createAppWebhook(deps, grant, param(context, "artifactId", "App"), body, context.req.url),
      ),
      201,
    );
  });

  app.patch(`${base}/webhooks/:webhookId`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    managed(context);
    const body = await json(context);
    context.header("cache-control", "no-store");
    return context.json(
      await run(() =>
        updateAppWebhook(
          deps,
          grant,
          param(context, "artifactId", "App"),
          param(context, "webhookId", "Webhook"),
          body,
          context.req.url,
        ),
      ),
    );
  });

  app.delete(`${base}/webhooks/:webhookId`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    managed(context);
    return context.json(
      await run(() =>
        deleteAppWebhook(
          deps,
          grant,
          param(context, "artifactId", "App"),
          param(context, "webhookId", "Webhook"),
        ),
      ),
    );
  });

  app.post(`${base}/notify`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    const body = await json(context);
    return context.json(
      await run(() =>
        notifyFromApp(deps, grant, param(context, "artifactId", "App"), body, surface(context)),
      ),
    );
  });

  // The public intake: the address names the webhook; its secret, as a
  // bearer token or an HMAC signature over the raw body, authenticates the
  // sender. Unknown addresses are 404.
  app.post("/v1/webhooks/apps/:workspaceId/:webhookId", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const webhookId = context.req.param("webhookId");
    if (!Id.safeParse(workspaceId).success || !Id.safeParse(webhookId).success)
      return context.json({ error: "not found" }, 404);
    const body = await readBoundedRawBody(
      context.req.raw,
      APP_WEBHOOK_BODY_MAX_BYTES,
      "webhook payload is too large",
    );
    const result = await receiveAppWebhook(deps, {
      workspaceId,
      webhookId,
      headers: context.req.raw.headers,
      body,
    });
    context.header("cache-control", "no-store");
    switch (result.outcome) {
      case "not_found":
        return context.json({ error: "not found" }, 404);
      case "rejected":
        return context.json({ error: result.reason }, result.status);
      case "invalid":
        return context.json({ error: result.reason }, 400);
      case "written":
        return context.json(result.result, 200);
    }
  });
}
