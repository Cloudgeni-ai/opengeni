import { SITE_FRAME_HEADER } from "@opengeni/contracts/site-session-http";
import type { Permission } from "@opengeni/contracts";
import { hasPermission, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import { SiteDataError } from "@opengeni/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  appSyncOptInReview,
  appSyncStatusForSite,
  createAppSync,
  deleteAppSync,
  listAppSyncs,
  runAppSyncNow,
  setAppSyncOptIn,
  updateAppSync,
} from "../app-sync/service";
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
 * App data sync routes (docs/app-sync.md), under
 * `/v1/workspaces/:workspaceId/published-artifacts/:artifactId`:
 *
 * - `GET /data/syncs`: each sync's last run, readable by the App's own page
 *   (`site.data.syncs()`) and anyone who can see the App.
 * - `GET|POST /syncs`, `PATCH|DELETE /syncs/:syncId`, `POST /syncs/:syncId/run`:
 *   managers, outside the App's frame.
 * - `GET /syncs/:syncId/opt-in`: what a person confirms before opting in (the
 *   tool, their accounts of it, the collection), outside the App's frame.
 * - `PUT|DELETE /syncs/:syncId/subscription`: a person opts in to or out of a
 *   personal sync, outside the App's frame. `PUT` takes `{ account? }`.
 */
export function registerAppSyncRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/published-artifacts/:artifactId";
  const grantFor = async (context: Context, permission: Permission, also?: Permission) => {
    const grant = await requireAccessGrant(
      context,
      deps,
      context.req.param("workspaceId")!,
      permission,
    );
    if (also && !hasPermission(grant.permissions, also))
      throw siteDataHttpError(new SiteDataError("forbidden", `Managing syncs also needs ${also}`));
    return grant;
  };
  const managed = (context: Context) => {
    if (surface(context).frameSiteId !== undefined)
      throw siteDataHttpError(
        new SiteDataError("forbidden", "Syncs are managed from Opengeni, not from inside the app"),
      );
  };
  const json = async (context: Context) => await context.req.json().catch(() => null);

  app.get(`${base}/data/syncs`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    context.header("cache-control", "no-store");
    return context.json(
      await run(() =>
        appSyncStatusForSite(deps, grant, param(context, "artifactId", "App"), surface(context)),
      ),
    );
  });

  app.get(`${base}/syncs`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    managed(context);
    return context.json({
      syncs: await run(() => listAppSyncs(deps, grant, param(context, "artifactId", "App"))),
    });
  });

  app.post(`${base}/syncs`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish", "scheduled_tasks:manage");
    managed(context);
    const body = await json(context);
    return context.json(
      await run(() => createAppSync(deps, grant, param(context, "artifactId", "App"), body)),
      201,
    );
  });

  app.patch(`${base}/syncs/:syncId`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish", "scheduled_tasks:manage");
    managed(context);
    const body = await json(context);
    return context.json(
      await run(() =>
        updateAppSync(
          deps,
          grant,
          param(context, "artifactId", "App"),
          param(context, "syncId", "Sync"),
          body,
        ),
      ),
    );
  });

  app.delete(`${base}/syncs/:syncId`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish", "scheduled_tasks:manage");
    managed(context);
    return context.json(
      await run(() =>
        deleteAppSync(
          deps,
          grant,
          param(context, "artifactId", "App"),
          param(context, "syncId", "Sync"),
        ),
      ),
    );
  });

  app.post(`${base}/syncs/:syncId/run`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish", "scheduled_tasks:run");
    managed(context);
    return context.json(
      await run(() =>
        runAppSyncNow(
          deps,
          grant,
          param(context, "artifactId", "App"),
          param(context, "syncId", "Sync"),
        ),
      ),
    );
  });

  app.get(`${base}/syncs/:syncId/opt-in`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    context.header("cache-control", "no-store");
    return context.json(
      await run(() =>
        appSyncOptInReview(
          deps,
          grant,
          param(context, "artifactId", "App"),
          param(context, "syncId", "Sync"),
          surface(context),
        ),
      ),
    );
  });

  for (const [method, optedIn] of [
    ["put", true],
    ["delete", false],
  ] as const)
    app[method](`${base}/syncs/:syncId/subscription`, async (context) => {
      const grant = await grantFor(context, "artifacts:read");
      const body = optedIn ? await json(context) : null;
      return context.json(
        await run(() =>
          setAppSyncOptIn(
            deps,
            grant,
            param(context, "artifactId", "App"),
            param(context, "syncId", "Sync"),
            optedIn,
            surface(context),
            body ?? {},
          ),
        ),
      );
    });
}
