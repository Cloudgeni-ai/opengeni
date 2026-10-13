import {
  SiteDataCollectionDefinitionRequest,
  SiteDataConfirmRequest,
  SiteDataFileScope,
  SiteDataGetRequest,
  SiteDataImportRequest,
  SiteDataQueryRequest,
  SiteDataWriteRequest,
  SITE_DATA_ERROR_STATUS,
  type ErrorCode,
} from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import { SiteDataError } from "@opengeni/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ApiHttpError } from "../http/api-error";
import {
  defineSiteDataCollection,
  deleteSiteDataCollection,
  deleteSiteDataFile,
  describeSiteData,
  exportSiteData,
  getSiteDataFileUrl,
  getSiteDataRecord,
  importSiteData,
  listSiteDataFiles,
  querySiteData,
  resetSiteDataCollection,
  uploadSiteDataFile,
  writeSiteData,
} from "../site-data/operations";
import type { SiteDataSurface } from "../site-data/service";

const SiteId = z.string().uuid();

const PUBLIC_CODE: Record<SiteDataError["code"], ErrorCode> = {
  validation: "validation_failed",
  conflict: "conflict",
  not_found: "not_found",
  forbidden: "forbidden",
  quota_exceeded: "limit_exceeded",
  rate_limited: "limit_exceeded",
};

/** Typed Site Data errors in the public envelope; `details.code` is the Site Data code. */
export function siteDataHttpError(error: SiteDataError): ApiHttpError {
  return new ApiHttpError(SITE_DATA_ERROR_STATUS[error.code], {
    code: PUBLIC_CODE[error.code],
    message: error.message,
    retryable: error.code === "rate_limited",
    outcomeUnknown: false,
    details: { ...error.details, code: error.code },
  });
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SiteDataError) throw siteDataHttpError(error);
    throw error;
  }
}

function invalid(message: string): ApiHttpError {
  return siteDataHttpError(new SiteDataError("validation", message));
}

async function body<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success)
    throw invalid(
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
        .join("; "),
    );
  return parsed.data;
}

function siteId(context: Context): string {
  const parsed = SiteId.safeParse(context.req.param("artifactId"));
  if (!parsed.success) throw siteDataHttpError(new SiteDataError("not_found", "Site not found"));
  return parsed.data;
}

/** Requests a host forwards from a Site frame carry its pinned Site id. */
function surface(context: Context): SiteDataSurface {
  const frame = context.req.header("x-opengeni-site-id");
  return frame ? { frameSiteId: frame } : {};
}

/**
 * Site Data routes. Reads and record writes need Site access (the viewer's
 * audience and `artifacts:read`); the collection's access mode decides the
 * rest. Management (describe, define, reset, import, export) needs a manager.
 */
export function registerSiteDataRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/published-artifacts/:artifactId";
  const grantFor = (context: Context, permission: "artifacts:read" | "artifacts:publish") =>
    requireAccessGrant(context, deps, context.req.param("workspaceId")!, permission);

  app.get(`${base}/data`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    if (surface(context).frameSiteId) throw invalid("Use site.data from a Site");
    return context.json(await run(() => describeSiteData(deps, grant, siteId(context))));
  });

  app.put(`${base}/data/collections/:name`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    const request = await body(context, SiteDataCollectionDefinitionRequest);
    if (surface(context).frameSiteId)
      throw siteDataHttpError(new SiteDataError("forbidden", "A Site cannot define collections"));
    const result = await run(() =>
      defineSiteDataCollection(deps, grant, siteId(context), context.req.param("name")!, request),
    );
    return context.json(result.collection, result.created ? 201 : 200);
  });

  app.delete(`${base}/data/collections/:name`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    if (context.req.query("confirm") !== "true")
      throw invalid("Deleting a collection needs confirm=true");
    if (surface(context).frameSiteId)
      throw siteDataHttpError(new SiteDataError("forbidden", "A Site cannot delete collections"));
    return context.json(
      await run(() =>
        deleteSiteDataCollection(deps, grant, siteId(context), context.req.param("name")!),
      ),
    );
  });

  app.post(`${base}/data/collections/:name/reset`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    await body(context, SiteDataConfirmRequest);
    if (surface(context).frameSiteId)
      throw siteDataHttpError(new SiteDataError("forbidden", "A Site cannot clear collections"));
    return context.json(
      await run(() =>
        resetSiteDataCollection(deps, grant, siteId(context), context.req.param("name")!),
      ),
    );
  });

  app.post(`${base}/data/collections/:name/import`, async (context) => {
    const grant = await grantFor(context, "artifacts:publish");
    const request = await body(context, SiteDataImportRequest);
    if (surface(context).frameSiteId)
      throw siteDataHttpError(new SiteDataError("forbidden", "A Site cannot import records"));
    return context.json(
      await run(() =>
        importSiteData(deps, grant, siteId(context), context.req.param("name")!, request),
      ),
    );
  });

  app.get(`${base}/data/collections/:name/export`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    const format = context.req.query("format") === "csv" ? "csv" : "json";
    if (surface(context).frameSiteId)
      throw siteDataHttpError(new SiteDataError("forbidden", "A Site cannot export records"));
    const name = context.req.param("name")!;
    const exported = await run(() => exportSiteData(deps, grant, siteId(context), name, format));
    return new Response(exported.content, {
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json",
        "Content-Disposition": `attachment; filename="${name}.${format}"`,
        "X-Content-Type-Options": "nosniff",
        "X-OpenGeni-Export-Truncated": exported.truncated ? "true" : "false",
      },
    });
  });

  app.post(`${base}/data/query`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    const request = await body(context, SiteDataQueryRequest);
    return context.json(
      await run(() => querySiteData(deps, grant, siteId(context), request, surface(context))),
    );
  });

  app.post(`${base}/data/get`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    const request = await body(context, SiteDataGetRequest);
    const record = await run(() =>
      getSiteDataRecord(deps, grant, siteId(context), request, surface(context)),
    );
    return context.json({ record });
  });

  app.post(`${base}/data/write`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    const request = await body(context, SiteDataWriteRequest);
    const written = await run(() =>
      writeSiteData(deps, grant, siteId(context), request.operations, surface(context)),
    );
    return context.json({ results: written.results });
  });

  app.get(`${base}/files`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    const limit = Number(context.req.query("limit") ?? "100");
    return context.json(
      await run(() =>
        listSiteDataFiles(
          deps,
          grant,
          siteId(context),
          {
            limit: Number.isFinite(limit) ? limit : 100,
            cursor: context.req.query("cursor") ?? null,
          },
          surface(context),
        ),
      ),
    );
  });

  app.post(`${base}/files`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    const scope = SiteDataFileScope.safeParse(context.req.query("scope") ?? "shared");
    if (!scope.success) throw invalid("scope must be shared or private");
    const declared = Number(context.req.header("content-length") ?? "0");
    if (declared > deps.settings.siteDataMaxFileBytes)
      throw siteDataHttpError(
        new SiteDataError("quota_exceeded", "This file is too large", {
          quota: "file_bytes",
          limit: deps.settings.siteDataMaxFileBytes,
        }),
      );
    const bytes = new Uint8Array(await context.req.arrayBuffer());
    const file = await run(() =>
      uploadSiteDataFile(
        deps,
        grant,
        siteId(context),
        {
          name: context.req.query("name"),
          contentType: context.req.header("content-type"),
          bytes,
          scope: scope.data,
        },
        surface(context),
      ),
    );
    return context.json(file, 201);
  });

  app.get(`${base}/files/:fileId`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    return context.json(
      await run(() =>
        getSiteDataFileUrl(
          deps,
          grant,
          siteId(context),
          context.req.param("fileId")!,
          surface(context),
        ),
      ),
    );
  });

  app.delete(`${base}/files/:fileId`, async (context) => {
    const grant = await grantFor(context, "artifacts:read");
    return context.json(
      await run(() =>
        deleteSiteDataFile(
          deps,
          grant,
          siteId(context),
          context.req.param("fileId")!,
          surface(context),
        ),
      ),
    );
  });
}
