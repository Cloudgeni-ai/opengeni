import { SITE_FRAME_HEADER } from "@opengeni/contracts/site-session-http";
import {
  SITE_SQL_ERROR_STATUS,
  SiteSqlExportFormat,
  SiteSqlImportRequest,
  SiteSqlMigrationRequest,
  SiteSqlResetRequest,
  SiteSqlStatementRequest,
  SiteSqlQueryDefinitionRequest,
  SiteSqlRunRequest,
  SiteSqlSettingsRequest,
  type ErrorCode,
  type SiteSqlErrorCode,
} from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ApiHttpError } from "../http/api-error";
import { USER_CONTENT_SECURITY_HEADERS } from "../http/user-content";
import type { SiteDataSurface } from "../site-data/service";
import {
  defineSiteSqlQuery,
  describeSiteSql,
  exportSiteSql,
  importSiteSql,
  inspectSiteSql,
  migrateSiteSql,
  resetSiteSql,
  runSiteSqlQuery,
  runSiteSqlStatement,
  setSiteSqlSettings,
  SiteSqlError,
} from "../site-sql/service";

const SiteId = z.string().uuid();

const PUBLIC_CODE: Record<SiteSqlErrorCode, ErrorCode> = {
  validation: "validation_failed",
  sql_error: "validation_failed",
  conflict: "conflict",
  disabled: "conflict",
  not_found: "not_found",
  forbidden: "forbidden",
  quota_exceeded: "limit_exceeded",
  rate_limited: "limit_exceeded",
  unavailable: "upstream_unavailable",
};

/** Typed Site SQL errors in the public envelope; `details.code` is the Site SQL code. */
export function siteSqlHttpError(error: SiteSqlError): ApiHttpError {
  return new ApiHttpError(SITE_SQL_ERROR_STATUS[error.code], {
    code: PUBLIC_CODE[error.code],
    message: error.message,
    retryable: error.code === "rate_limited" || error.details.retryable === true,
    outcomeUnknown: error.details.outcomeUnknown === true,
    details: { ...error.details, code: error.code },
  });
}

export async function runSiteSqlRoute<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SiteSqlError) throw siteSqlHttpError(error);
    throw error;
  }
}

export async function siteSqlBody<S extends z.ZodType>(
  context: Context,
  schema: S,
): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success)
    throw siteSqlHttpError(
      new SiteSqlError(
        "validation",
        parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
          .join("; "),
      ),
    );
  return parsed.data;
}

function siteId(context: Context): string {
  const parsed = SiteId.safeParse(context.req.param("artifactId"));
  if (!parsed.success) throw siteSqlHttpError(new SiteSqlError("not_found", "Site not found"));
  return parsed.data;
}

/** Like Site Data: the frame marker or pinned Site id makes a request framed. */
function surface(context: Context): SiteDataSurface {
  const frame = context.req.header("x-opengeni-site-id");
  const marked = context.req.header(SITE_FRAME_HEADER) !== undefined;
  if (!frame && !marked) return {};
  return { frameSiteId: frame ?? "" };
}

function refuseFramed(context: Context, what: string): void {
  if (surface(context).frameSiteId !== undefined)
    throw siteSqlHttpError(new SiteSqlError("forbidden", `A Site cannot ${what}`));
}

/**
 * Site SQL routes. Running a named query needs Site access (`artifacts:read`
 * and the viewer's audience); the query's audience decides the rest. Everything
 * else is management: a manager of the Site outside any Site frame, with
 * `artifacts:read` to look and `artifacts:publish` to change.
 */
export function registerSiteSqlRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/published-artifacts/:artifactId/sql";
  const grantFor = (context: Context, permission: "artifacts:read" | "artifacts:publish") =>
    requireAccessGrant(context, deps, context.req.param("workspaceId")!, permission);

  app.get(base, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    refuseFramed(context, "manage its database");
    return context.json(await runSiteSqlRoute(() => describeSiteSql(deps, grant, siteId(context))));
  });

  app.put(`${base}/settings`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    const request = await siteSqlBody(context, SiteSqlSettingsRequest);
    refuseFramed(context, "manage its database");
    return context.json(
      await runSiteSqlRoute(() => setSiteSqlSettings(deps, grant, siteId(context), request)),
    );
  });

  app.post(`${base}/queries/:name`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    const request = await siteSqlBody(context, SiteSqlRunRequest);
    return context.json(
      await runSiteSqlRoute(() =>
        runSiteSqlQuery(
          deps,
          grant,
          siteId(context),
          context.req.param("name")!,
          request.params ?? {},
          surface(context),
        ),
      ),
    );
  });

  app.put(`${base}/queries/:name`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    const request = await siteSqlBody(context, SiteSqlQueryDefinitionRequest);
    refuseFramed(context, "define queries");
    const result = await runSiteSqlRoute(() =>
      defineSiteSqlQuery(deps, grant, siteId(context), context.req.param("name")!, request),
    );
    return context.json(result.query, result.created ? 201 : 200);
  });

  app.delete(`${base}/queries/:name`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    refuseFramed(context, "delete queries");
    await runSiteSqlRoute(() =>
      defineSiteSqlQuery(deps, grant, siteId(context), context.req.param("name")!, null),
    );
    return context.json({ deleted: true });
  });

  app.post(`${base}/migrations`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    const request = await siteSqlBody(context, SiteSqlMigrationRequest);
    refuseFramed(context, "change its database schema");
    return context.json(
      await runSiteSqlRoute(() => migrateSiteSql(deps, grant, siteId(context), request)),
      201,
    );
  });

  app.post(`${base}/query`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    const request = await siteSqlBody(context, SiteSqlStatementRequest);
    refuseFramed(context, "run ad hoc SQL");
    return context.json(
      await runSiteSqlRoute(() =>
        runSiteSqlStatement(deps, grant, siteId(context), request, "read"),
      ),
    );
  });

  app.post(`${base}/execute`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    const request = await siteSqlBody(context, SiteSqlStatementRequest);
    refuseFramed(context, "run ad hoc SQL");
    return context.json(
      await runSiteSqlRoute(() =>
        runSiteSqlStatement(deps, grant, siteId(context), request, "write"),
      ),
    );
  });

  app.get(`${base}/inspect`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    refuseFramed(context, "inspect its database");
    return context.json(await runSiteSqlRoute(() => inspectSiteSql(deps, grant, siteId(context))));
  });

  app.get(`${base}/export`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    refuseFramed(context, "export its database");
    const format = SiteSqlExportFormat.safeParse(context.req.query("format") ?? "sql");
    if (!format.success)
      throw siteSqlHttpError(new SiteSqlError("validation", "format is sql, csv or json"));
    const table = context.req.query("table");
    const exported = await runSiteSqlRoute(() =>
      exportSiteSql(deps, grant, siteId(context), {
        format: format.data,
        ...(table ? { table } : {}),
      }),
    );
    return new Response(exported.content, {
      headers: {
        "Content-Type": exported.contentType,
        "Content-Disposition": `attachment; filename="${exported.filename}"`,
        ...USER_CONTENT_SECURITY_HEADERS,
        "X-OpenGeni-Export-Truncated": exported.truncated ? "true" : "false",
      },
    });
  });

  app.post(`${base}/import`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    const request = await siteSqlBody(context, SiteSqlImportRequest);
    refuseFramed(context, "import data");
    return context.json(
      await runSiteSqlRoute(() => importSiteSql(deps, grant, siteId(context), request)),
    );
  });

  app.post(`${base}/reset`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    const request = await siteSqlBody(context, SiteSqlResetRequest);
    refuseFramed(context, "reset its database");
    return context.json(
      await runSiteSqlRoute(() => resetSiteSql(deps, grant, siteId(context), request)),
    );
  });
}
