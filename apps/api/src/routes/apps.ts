import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  AppAvailableRuntimeCatalogResponse,
  AppBuildMutationResponse,
  AppBuildUploadListQuery,
  AppBuildUploadListResponse,
  AppReleaseMutationResponse,
  AppRuntimeCatalogResponse,
  AppRuntimeToolCallRequest,
  AppRuntimeToolCallResponse,
  AppSourceDownloadResponse,
  ArchiveWorkspaceAppRequest,
  BeginAppSourceUploadRequest,
  BeginAppSourceUploadResponse,
  CompleteAppBuildRequest,
  CompleteAppSourceUploadRequest,
  CreateAppLaunchRequest,
  CreateAppLaunchResponse,
  CreateAppPreviewRequest,
  CreateAppPreviewResponse,
  CreateAppToolPolicyRequest,
  CreateWorkspaceAppRequest,
  PrepareAppBuildRequest,
  PrepareAppBuildResponse,
  PromoteAppBuildRequest,
  PublishAppReleaseRequest,
  RollbackAppReleaseRequest,
  UnpublishWorkspaceAppRequest,
  UpdateWorkspaceAppRequest,
  WorkspaceAppDetailResponse,
  WorkspaceAppListQuery,
  WorkspaceAppListResponse,
  WorkspaceAppMutationResponse,
} from "@opengeni/contracts/apps";
import {
  appControlAuthority,
  requireAccessGrantAuthorization,
  requireAppCurrentHumanAuthority,
  type ApiRouteDeps,
  type AppControlAuthority,
  type AppCurrentHumanAuthority,
  type AppsApplicationPort,
} from "@opengeni/core";
import type { Permission } from "@opengeni/contracts";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const Id = z.string().uuid();
const APP_CSRF_COOKIE = "opengeni.app_csrf";
const APP_CSRF_HEADER = "x-opengeni-app-csrf";
const APP_CSRF_TTL_SECONDS = 60 * 60;
const AppHostResolveRequest = z
  .object({
    host: z.string().min(1).max(320),
    launchTokenDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    requestedPath: z.string().min(1).max(1_024).nullable(),
  })
  .strict();
const AppHostResolveResponse = z
  .object({
    appId: Id,
    releaseId: Id,
    launchId: Id,
    previewId: Id.nullable(),
    publicationId: Id.nullable(),
    expiresAt: z.string().datetime({ offset: true }),
    spaFallback: z.boolean(),
    requestedObject: z
      .object({
        path: z.string().min(1).max(1_024),
        objectKey: z.string().min(1).max(2_048),
        versionToken: z.string().min(1).max(2_048),
      })
      .strict()
      .nullable(),
    entryObject: z
      .object({
        path: z.string().min(1).max(1_024),
        objectKey: z.string().min(1).max(2_048),
        versionToken: z.string().min(1).max(2_048),
      })
      .strict(),
  })
  .strict();

function apps(deps: ApiRouteDeps): AppsApplicationPort {
  if (!deps.settings.appsEnabled) {
    throw new HTTPException(404, { message: "Apps are not enabled" });
  }
  if (!deps.apps) {
    throw new HTTPException(503, { message: "Apps are not configured in this deployment" });
  }
  return deps.apps;
}

function id(context: Context, name: string): string {
  const parsed = Id.safeParse(context.req.param(name));
  if (!parsed.success) throw new HTTPException(422, { message: `Invalid ${name}` });
  return parsed.data;
}

function workspaceId(context: Context): string {
  const parsed = Id.safeParse(context.req.param("workspaceId"));
  if (!parsed.success) throw new HTTPException(422, { message: "Invalid workspaceId" });
  return parsed.data;
}

async function body<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(422, { message: "Invalid Apps request" });
  return parsed.data;
}

function allowedOrigins(deps: ApiRouteDeps): Set<string> {
  const origins = new Set<string>();
  for (const candidate of [
    deps.settings.publicBaseUrl,
    deps.settings.webBaseUrl,
    ...deps.settings.betterAuthTrustedOrigins.split(","),
  ]) {
    if (!candidate?.trim()) continue;
    try {
      origins.add(new URL(candidate.trim()).origin);
    } catch {
      // Invalid configured origins are rejected by settings validation; keep
      // this request boundary fail-closed if an embedded host bypassed it.
    }
  }
  return origins;
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function mintAppCsrf(context: Context, deps: ApiRouteDeps): string {
  const token = randomBytes(32).toString("base64url");
  setCookie(context, APP_CSRF_COOKIE, token, {
    httpOnly: true,
    secure: deps.settings.publicBaseUrl?.startsWith("https://") ?? false,
    sameSite: "Strict",
    path: "/v1/workspaces/",
    maxAge: APP_CSRF_TTL_SECONDS,
  });
  return token;
}

function requireAppMutationAdmission(context: Context, deps: ApiRouteDeps): void {
  const origin = context.req.header("origin");
  const fetchSite = context.req.header("sec-fetch-site");
  const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim();
  const cookieToken = getCookie(context, APP_CSRF_COOKIE);
  const headerToken = context.req.header(APP_CSRF_HEADER);
  if (
    !origin ||
    !allowedOrigins(deps).has(origin) ||
    (fetchSite !== "same-origin" && fetchSite !== "same-site") ||
    contentType !== "application/json" ||
    !cookieToken ||
    !headerToken ||
    !equalSecret(cookieToken, headerToken)
  ) {
    throw new HTTPException(403, { message: "Apps browser mutation admission failed" });
  }
}

async function controlAuthority(
  context: Context,
  deps: ApiRouteDeps,
  permission: Permission,
  mutation: boolean,
): Promise<AppControlAuthority> {
  const access = await requireAccessGrantAuthorization(
    context,
    deps,
    workspaceId(context),
    permission,
  );
  if (mutation && access.canonicalManagedHumanSession) {
    requireAppMutationAdmission(context, deps);
  }
  return appControlAuthority(access);
}

async function currentHumanAuthority(
  context: Context,
  deps: ApiRouteDeps,
  permission: Permission,
  mutation: boolean,
): Promise<AppCurrentHumanAuthority> {
  const access = await requireAccessGrantAuthorization(
    context,
    deps,
    workspaceId(context),
    permission,
  );
  const currentHuman = requireAppCurrentHumanAuthority(access, context.req.raw);
  if (mutation && currentHuman.canonicalManagedHumanSession) {
    requireAppMutationAdmission(context, deps);
  }
  return currentHuman;
}

function signal(context: Context): { signal: AbortSignal } {
  return { signal: context.req.raw.signal };
}

export function registerAppRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/apps";

  app.post("/internal/apps/resolve-launch", async (context) => {
    const expected = deps.settings.appHostResolverKey;
    const actual = context.req.header("x-opengeni-app-host-resolver-key");
    if (!expected || !actual || !equalSecret(actual, expected)) {
      throw new HTTPException(404, { message: "not found" });
    }
    const parsed = AppHostResolveRequest.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(404, { message: "not found" });
    const resolution = await apps(deps).resolveHostLaunch(parsed.data, signal(context));
    if (!resolution) throw new HTTPException(404, { message: "not found" });
    return context.json(AppHostResolveResponse.parse(resolution));
  });

  app.get(`${base}/csrf`, async (context) => {
    await currentHumanAuthority(context, deps, "apps:read", false);
    return context.json({
      token: mintAppCsrf(context, deps),
      expiresInSeconds: APP_CSRF_TTL_SECONDS,
    });
  });

  app.get(base, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:read", false);
    const query = WorkspaceAppListQuery.safeParse({
      limit: context.req.query("limit"),
      cursor: context.req.query("cursor"),
    });
    if (!query.success) throw new HTTPException(422, { message: "Invalid Apps list query" });
    return context.json(
      WorkspaceAppListResponse.parse(
        await apps(deps).list({ authority: actor, query: query.data }, signal(context)),
      ),
    );
  });

  app.post(base, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:write", true);
    const request = await body(context, CreateWorkspaceAppRequest);
    return context.json(
      WorkspaceAppMutationResponse.parse(
        await apps(deps).create({ authority: actor, request }, signal(context)),
      ),
      201,
    );
  });

  app.get(`${base}/:appId`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:read", false);
    return context.json(
      WorkspaceAppDetailResponse.parse(
        await apps(deps).get({ authority: actor, appId: id(context, "appId") }, signal(context)),
      ),
    );
  });

  app.patch(`${base}/:appId`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:write", true);
    const request = await body(context, UpdateWorkspaceAppRequest);
    return context.json(
      WorkspaceAppMutationResponse.parse(
        await apps(deps).update(
          { authority: actor, appId: id(context, "appId"), request },
          signal(context),
        ),
      ),
    );
  });

  app.post(`${base}/:appId/tool-policies`, async (context) => {
    const actor = await currentHumanAuthority(context, deps, "apps:write", true);
    const request = await body(context, CreateAppToolPolicyRequest);
    return context.json(
      WorkspaceAppDetailResponse.parse(
        await apps(deps).createToolPolicy(
          { authority: actor, appId: id(context, "appId"), request },
          signal(context),
        ),
      ),
      201,
    );
  });

  app.get(`${base}/:appId/runtime/available-catalog`, async (context) => {
    const actor = await currentHumanAuthority(context, deps, "apps:write", false);
    return context.json(
      AppAvailableRuntimeCatalogResponse.parse(
        await apps(deps).getAvailableRuntimeCatalog(
          { authority: actor, appId: id(context, "appId") },
          signal(context),
        ),
      ),
    );
  });

  app.post(`${base}/:appId/source-revisions`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:write", true);
    const request = await body(context, BeginAppSourceUploadRequest);
    return context.json(
      BeginAppSourceUploadResponse.parse(
        await apps(deps).beginSourceUpload(
          { authority: actor, appId: id(context, "appId"), request },
          signal(context),
        ),
      ),
      201,
    );
  });

  app.post(`${base}/:appId/source-revisions/:sourceRevisionId/complete`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:write", true);
    const request = await body(context, CompleteAppSourceUploadRequest);
    return context.json(
      WorkspaceAppDetailResponse.parse(
        await apps(deps).completeSourceUpload(
          {
            authority: actor,
            appId: id(context, "appId"),
            sourceRevisionId: id(context, "sourceRevisionId"),
            request,
          },
          signal(context),
        ),
      ),
    );
  });

  app.get(`${base}/:appId/source-revisions/:sourceRevisionId/download`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:read", false);
    const downloadUrl = new URL(context.req.url);
    downloadUrl.pathname = `${downloadUrl.pathname}/content`;
    downloadUrl.search = "";
    downloadUrl.hash = "";
    return context.json(
      AppSourceDownloadResponse.parse(
        await apps(deps).getSourceDownload(
          {
            authority: actor,
            appId: id(context, "appId"),
            sourceRevisionId: id(context, "sourceRevisionId"),
            downloadUrl: downloadUrl.toString(),
          },
          signal(context),
        ),
      ),
    );
  });

  app.on(
    ["GET", "HEAD"],
    `${base}/:appId/source-revisions/:sourceRevisionId/download/content`,
    async (context) => {
      const actor = await controlAuthority(context, deps, "apps:read", false);
      const expiresAtSeconds = Number(context.req.query("expires"));
      const signature = context.req.query("signature") ?? "";
      const source = await apps(deps).openSourceDownload(
        {
          authority: actor,
          appId: id(context, "appId"),
          sourceRevisionId: id(context, "sourceRevisionId"),
          expiresAtSeconds,
          signature,
        },
        signal(context),
      );
      return new Response(context.req.method === "HEAD" ? null : source.body, {
        status: 200,
        headers: {
          "cache-control": "private, no-store, max-age=0, no-transform",
          "content-disposition": 'attachment; filename="opengeni-app-source.tar"',
          "content-length": String(source.byteSize),
          "content-type": source.contentType,
          "x-content-type-options": "nosniff",
        },
      });
    },
  );

  app.post(`${base}/:appId/builds`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:write", true);
    const request = await body(context, PrepareAppBuildRequest);
    return context.json(
      PrepareAppBuildResponse.parse(
        await apps(deps).prepareBuild(
          { authority: actor, appId: id(context, "appId"), request },
          signal(context),
        ),
      ),
      201,
    );
  });

  app.get(`${base}/:appId/builds/:buildId/uploads`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:write", false);
    const query = AppBuildUploadListQuery.safeParse({
      limit: context.req.query("limit"),
      cursor: context.req.query("cursor"),
    });
    if (!query.success) throw new HTTPException(422, { message: "Invalid build upload query" });
    return context.json(
      AppBuildUploadListResponse.parse(
        await apps(deps).listBuildUploads(
          {
            authority: actor,
            appId: id(context, "appId"),
            buildId: id(context, "buildId"),
            query: query.data,
          },
          signal(context),
        ),
      ),
    );
  });

  app.post(`${base}/:appId/builds/:buildId/complete`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:write", true);
    const request = await body(context, CompleteAppBuildRequest);
    return context.json(
      AppBuildMutationResponse.parse(
        await apps(deps).completeBuild(
          {
            authority: actor,
            appId: id(context, "appId"),
            buildId: id(context, "buildId"),
            request,
          },
          signal(context),
        ),
      ),
    );
  });

  app.post(`${base}/:appId/releases`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:publish", true);
    const request = await body(context, PromoteAppBuildRequest);
    return context.json(
      AppReleaseMutationResponse.parse(
        await apps(deps).promoteBuild(
          { authority: actor, appId: id(context, "appId"), request },
          signal(context),
        ),
      ),
      201,
    );
  });

  app.post(`${base}/:appId/previews`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:publish", true);
    const request = await body(context, CreateAppPreviewRequest);
    return context.json(
      CreateAppPreviewResponse.parse(
        await apps(deps).createPreview(
          { authority: actor, appId: id(context, "appId"), request },
          signal(context),
        ),
      ),
      201,
    );
  });

  app.post(`${base}/:appId/publish`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:publish", true);
    const request = await body(context, PublishAppReleaseRequest);
    return context.json(
      AppReleaseMutationResponse.parse(
        await apps(deps).publish(
          { authority: actor, appId: id(context, "appId"), request },
          signal(context),
        ),
      ),
    );
  });

  app.post(`${base}/:appId/rollback`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:publish", true);
    const request = await body(context, RollbackAppReleaseRequest);
    return context.json(
      AppReleaseMutationResponse.parse(
        await apps(deps).rollback(
          { authority: actor, appId: id(context, "appId"), request },
          signal(context),
        ),
      ),
    );
  });

  app.post(`${base}/:appId/unpublish`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:publish", true);
    const request = await body(context, UnpublishWorkspaceAppRequest);
    return context.json(
      WorkspaceAppMutationResponse.parse(
        await apps(deps).unpublish(
          { authority: actor, appId: id(context, "appId"), request },
          signal(context),
        ),
      ),
    );
  });

  app.post(`${base}/:appId/archive`, async (context) => {
    const actor = await controlAuthority(context, deps, "apps:delete", true);
    const request = await body(context, ArchiveWorkspaceAppRequest);
    return context.json(
      WorkspaceAppMutationResponse.parse(
        await apps(deps).archive(
          { authority: actor, appId: id(context, "appId"), request },
          signal(context),
        ),
      ),
    );
  });

  app.post(`${base}/:appId/launches`, async (context) => {
    const actor = await currentHumanAuthority(context, deps, "apps:run", true);
    const request = await body(context, CreateAppLaunchRequest);
    return context.json(
      CreateAppLaunchResponse.parse(
        await apps(deps).createLaunch(
          { authority: actor, appId: id(context, "appId"), request },
          signal(context),
        ),
      ),
      201,
    );
  });

  app.get(`${base}/:appId/runtime/catalog`, async (context) => {
    const actor = await currentHumanAuthority(context, deps, "apps:run", false);
    const releaseId = Id.safeParse(context.req.query("releaseId"));
    if (!releaseId.success) throw new HTTPException(422, { message: "Invalid releaseId" });
    return context.json(
      AppRuntimeCatalogResponse.parse(
        await apps(deps).getRuntimeCatalog(
          { authority: actor, appId: id(context, "appId"), releaseId: releaseId.data },
          signal(context),
        ),
      ),
    );
  });

  app.post(`${base}/:appId/runtime/tool-calls`, async (context) => {
    const actor = await currentHumanAuthority(context, deps, "apps:run", true);
    const request = await body(context, AppRuntimeToolCallRequest);
    const releaseId = context.req.header("x-opengeni-app-release-id");
    const launchId = context.req.header("x-opengeni-app-launch-id");
    const authorityGeneration = context.req.header("x-opengeni-app-authority-generation");
    const launchNonce = context.req.header("x-opengeni-app-launch-nonce");
    if (!releaseId || !Id.safeParse(releaseId).success) {
      throw new HTTPException(422, { message: "Invalid App release identity" });
    }
    if (!launchId || !Id.safeParse(launchId).success) {
      throw new HTTPException(422, { message: "Invalid App launch identity" });
    }
    if (!launchNonce || launchNonce.length < 32 || launchNonce.length > 256) {
      throw new HTTPException(422, { message: "Invalid App launch nonce" });
    }
    if (!authorityGeneration || authorityGeneration.length > 256) {
      throw new HTTPException(422, { message: "Invalid App authority generation" });
    }
    return context.json(
      AppRuntimeToolCallResponse.parse(
        await apps(deps).callRuntimeTool(
          {
            authority: actor,
            appId: id(context, "appId"),
            releaseId,
            launchId,
            authorityGeneration,
            launchNonce,
            request,
          },
          signal(context),
        ),
      ),
    );
  });

  app.delete(`${base}/csrf`, async (context) => {
    await currentHumanAuthority(context, deps, "apps:read", true);
    deleteCookie(context, APP_CSRF_COOKIE, { path: "/v1/workspaces/" });
    return context.body(null, 204);
  });
}
