import { SITE_FRAME_HEADER } from "@opengeni/contracts/site-session-http";
import type { ErrorCode, Permission } from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  AppServerError,
  appServerRuns,
  appServerStatus,
  runAppServerAs,
  type AppServerErrorCode,
} from "../app-server/service";
import { ApiHttpError } from "../http/api-error";

const Id = z.string().uuid();

const STATUS: Record<AppServerErrorCode, number> = {
  validation: 400,
  not_found: 404,
  forbidden: 403,
  rate_limited: 429,
  unavailable: 503,
  conflict: 409,
};
const PUBLIC_CODE: Record<AppServerErrorCode, ErrorCode> = {
  validation: "validation_failed",
  not_found: "not_found",
  forbidden: "forbidden",
  rate_limited: "limit_exceeded",
  unavailable: "upstream_unavailable",
  conflict: "conflict",
};

/** App server code errors in the public envelope; `details.code` is the app server code. */
export function appServerHttpError(error: AppServerError): ApiHttpError {
  return new ApiHttpError(STATUS[error.code], {
    code: PUBLIC_CODE[error.code],
    message: error.message,
    retryable: error.code === "rate_limited" || error.details.retryable === true,
    outcomeUnknown: false,
    details: { ...error.details, code: error.code },
  });
}

export async function runAppServerRoute<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppServerError) throw appServerHttpError(error);
    throw error;
  }
}

function siteId(context: Context): string {
  const parsed = Id.safeParse(context.req.param("artifactId"));
  if (!parsed.success) throw appServerHttpError(new AppServerError("not_found", "App not found"));
  return parsed.data;
}

function frameSiteId(context: Context): string | undefined {
  const frame = context.req.header("x-opengeni-site-id");
  const marked = context.req.header(SITE_FRAME_HEADER) !== undefined;
  if (!frame && !marked) return undefined;
  return frame ?? "";
}

/**
 * App server code (docs/app-server-code.md), under
 * `/v1/workspaces/:workspaceId/published-artifacts/:artifactId/server`:
 *
 * - `POST /server`: `site.server.fetch` from the app's page in the console
 *   (or any caller who can open the app); runs the app's current code.
 * - `GET /server/status` and `GET /server/runs`: the app's managers, outside
 *   the app's frame.
 */
export function registerAppServerRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/published-artifacts/:artifactId/server";
  const grantFor = async (context: Context, permission: Permission) =>
    await requireAccessGrant(context, deps, context.req.param("workspaceId")!, permission);
  const managed = (context: Context) => {
    if (frameSiteId(context) !== undefined)
      throw appServerHttpError(
        new AppServerError("forbidden", "An app can't read its own server code's runs"),
      );
  };

  app.post(base, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    const body = await context.req.json().catch(() => null);
    context.header("cache-control", "no-store");
    const frame = frameSiteId(context);
    return context.json(
      await runAppServerRoute(() =>
        runAppServerAs(deps, grant, siteId(context), body, {
          ...(frame === undefined ? {} : { frameSiteId: frame }),
        }),
      ),
    );
  });

  app.get(`${base}/status`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    managed(context);
    context.header("cache-control", "no-store");
    return context.json(
      await runAppServerRoute(() => appServerStatus(deps, grant, siteId(context))),
    );
  });

  app.get(`${base}/runs`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    managed(context);
    const limit = Number(context.req.query("limit") ?? "20");
    const status = context.req.query("status");
    const before = context.req.query("before");
    context.header("cache-control", "no-store");
    return context.json(
      await runAppServerRoute(() =>
        appServerRuns(deps, grant, siteId(context), {
          limit: Number.isFinite(limit) ? limit : 20,
          ...(status === "ok" || status === "error" ? { status } : {}),
          ...(before ? { before } : {}),
        }),
      ),
    );
  });
}
