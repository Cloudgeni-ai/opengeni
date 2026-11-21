import { AppPackageExportRequest, AppPackageInstallRequest } from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  appInstallOperationKey,
  appPackageHttpError,
  exportAppPackage,
  installAppPackage,
} from "../app-packages/service";
import { parseRequestBody } from "../http/request-body";

const AppId = z.string().uuid();

async function body<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  return parseRequestBody(schema, await context.req.json().catch(() => null), {
    status: 422,
    message: "Invalid app package request",
  });
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw appPackageHttpError(error) ?? error;
  }
}

/**
 * App packages (docs/app-packages.md): export an app as one file, and
 * install a package file into this workspace as a new app.
 */
export function registerAppPackageRoutes(app: Hono, deps: ApiRouteDeps): void {
  // The package of an app's current version. Its managers only (the same
  // check as reading its data definitions); demo data only when asked.
  app.post(
    "/v1/workspaces/:workspaceId/published-artifacts/:artifactId/package",
    async (context) => {
      const workspaceId = context.req.param("workspaceId");
      const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
      const parsedId = AppId.safeParse(context.req.param("artifactId"));
      if (!parsedId.success) throw new HTTPException(422, { message: "Invalid app id" });
      const request = await body(context, AppPackageExportRequest);
      const exported = await run(() => exportAppPackage(deps, grant, parsedId.data, request));
      return context.json(exported, 200, { "Cache-Control": "private, no-store" });
    },
  );

  // A new app from a package file, like creating an app (artifacts:publish).
  app.post("/v1/workspaces/:workspaceId/app-packages/install", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "artifacts:publish",
    );
    const grant = authorization.grant;
    const request = await body(context, AppPackageInstallRequest);
    const result = await run(() =>
      installAppPackage(deps, grant, {
        package: request.package,
        title: request.title,
        visibility: request.visibility,
        demoData: request.demoData,
        provenance: {
          // Its own namespace: the key cannot replay a create or a copy, and
          // a different package with the same key installs a different app.
          operationKey: appInstallOperationKey(
            "subject",
            grant.subjectId,
            request.idempotencyKey,
            request.package,
          ),
          actorSubjectId: grant.subjectId,
          sourceSessionId: null,
          sourceTurnId: null,
          sourceAttemptId: null,
          sourceExecutionGeneration: null,
          sourceToolName: null,
        },
      }),
    );
    return context.json(result, result.replayed ? 200 : 201);
  });
}
