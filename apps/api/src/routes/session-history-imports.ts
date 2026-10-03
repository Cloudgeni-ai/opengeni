import {
  AppendArchivedSessionEventsRequest,
  ImportArchivedSessionRequest,
  SESSION_HISTORY_IMPORT_MAX_BODY_BYTES,
} from "@opengeni/contracts";
import { ExternalIdentityReference } from "@opengeni/contracts/external-identities";
import {
  accountScopedApiKeyWorkspaceAuthority,
  ArchivedSessionImportError,
  appendArchivedSessionEventsForRequest,
  externalAttributionForAuthorization,
  importArchivedSessionForRequest,
  isVerifiedOrganizationServiceAuthorization,
  requireAccessContext,
  requireAccessGrantAuthorization,
  requireResolvedAccessGrantAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  SessionTenancyManagedHumanRequiredError,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  findWorkspaceByExternalIdentity,
  SessionTenancyNotActivatedError,
  withAccountRls,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

/** Exact server-only routes with their own bounded, streaming JSON ingress. */
export function isSessionHistoryImportRequest(method: string, pathname: string): boolean {
  return (
    method === "POST" &&
    /^\/v1\/workspaces\/(?:[^/]+|external\/[^/]+\/[^/]+)\/session-imports(?:\/[^/]+\/events)?$/.test(
      pathname,
    )
  );
}

class InvalidSessionImportRequestError extends Error {
  constructor() {
    super("Invalid archived session import request.");
  }
}

/** Resolve an existing organization-local mapping, never provision a tenant. */
async function resolveWorkspace(c: Context, deps: ApiRouteDeps): Promise<string> {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) return workspaceId;
  const context = await requireAccessContext(c, deps);
  const organizationKey = accountScopedApiKeyWorkspaceAuthority(context);
  // The canonical resolver routes every external-actor header through API-key
  // authentication before considering delegated tokens or browser cookies.
  // Thus this account comes from an authenticated asUser context, not a label.
  const externalAccountId =
    c.req.header("x-opengeni-external-actor") !== undefined ? context.defaultAccountId : null;
  const accountId = organizationKey?.accountId ?? externalAccountId;
  if (!accountId) throw new HTTPException(404, { message: "Workspace not found" });
  const reference = ExternalIdentityReference.safeParse({
    source: c.req.param("source"),
    externalId: c.req.param("externalId"),
  });
  if (!reference.success) throw new InvalidSessionImportRequestError();
  const workspace = await withAccountRls(deps.db, accountId, (tx) =>
    findWorkspaceByExternalIdentity(tx, {
      accountId,
      externalSource: reference.data.source,
      externalId: reference.data.externalId,
    }),
  );
  if (!workspace) throw new HTTPException(404, { message: "Workspace not found" });
  return workspace.id;
}

/** Integration provenance is required even when another principal has create. */
async function authorize(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  permission: "sessions:create" | "sessions:control",
): Promise<AccessGrantAuthorization> {
  const context = await requireAccessContext(c, deps);
  const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId, permission);
  const grant = requireResolvedAccessGrantAuthorization(authorization, workspaceId);
  // credential is emitted only by authenticated API-key resolution. Delegated
  // grant shapes, browser cookies, service labels and agent metadata confer none.
  const workspaceKey =
    context.credential?.kind === "workspace_api_key" &&
    context.credential.accountId === grant.accountId &&
    context.credential.workspaceId === workspaceId;
  if (
    grant.principalKind === "agent_attempt" ||
    grant.metadata?.sessionId !== undefined ||
    !(
      workspaceKey ||
      isVerifiedOrganizationServiceAuthorization(authorization) ||
      externalAttributionForAuthorization(authorization, grant)
    )
  ) {
    throw new HTTPException(403, { message: "Session import requires an integration principal" });
  }
  return authorization;
}

/** Count raw UTF-8 bytes before decoding or parsing, including chunked bodies. */
export async function readSessionHistoryImportJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(length) || length < 0) {
      throw new InvalidSessionImportRequestError();
    }
    if (length > SESSION_HISTORY_IMPORT_MAX_BODY_BYTES) {
      await request.body?.cancel().catch(() => undefined);
      throw new InvalidSessionImportRequestError();
    }
  }
  if (!request.body) throw new InvalidSessionImportRequestError();
  const reader = request.body.getReader();
  // A fixed byte buffer also bounds allocation overhead for one-byte chunks.
  const bytes = new Uint8Array(SESSION_HISTORY_IMPORT_MAX_BODY_BYTES);
  let total = 0;
  for (;;) {
    const next = await reader.read().catch(() => {
      throw new InvalidSessionImportRequestError();
    });
    if (next.done) break;
    if (next.value.byteLength > SESSION_HISTORY_IMPORT_MAX_BODY_BYTES - total) {
      await reader.cancel().catch(() => undefined);
      throw new InvalidSessionImportRequestError();
    }
    bytes.set(next.value, total);
    total += next.value.byteLength;
  }
  // Bun's server request reader can throw from releaseLock(); this request-local
  // reader is discarded after complete consumption or cancellation instead.
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total)),
    ) as unknown;
  } catch {
    throw new InvalidSessionImportRequestError();
  }
}

/** Also used by the composed API for imported-session Send/Steer refusals. */
export function archivedSessionImportErrorResponse(c: Context, error: unknown): Response | null {
  // SQLSTATE OG002 is also used for unrelated admission refusals. Match the
  // archive guard's closed message on the exact driver error, including a
  // wrapped cause, rather than exposing SQL text or reclassifying every OG002.
  const seen = new Set<object>();
  let candidate = error;
  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    const failure = candidate as { code?: unknown; message?: unknown; cause?: unknown };
    if (failure.code === "OG002" && failure.message === "SESSION_IMPORTED_READ_ONLY") {
      return c.json(
        { code: "SESSION_IMPORTED_READ_ONLY", message: "Imported session history is read-only" },
        409,
      );
    }
    candidate = failure.cause;
  }
  const domainError =
    error instanceof ArchivedSessionImportError
      ? error
      : error instanceof HTTPException && error.cause instanceof ArchivedSessionImportError
        ? error.cause
        : null;
  if (!domainError) return null;
  if (domainError.code === "SESSION_IMPORT_INVALID_FILE") {
    return c.json(
      {
        code: "INVALID_SESSION_IMPORT_REQUEST",
        message: "Invalid archived session import request.",
      },
      422,
    );
  }
  if (domainError.code === "SESSION_IMPORT_NOT_FOUND") {
    return c.json(
      { code: "SESSION_IMPORT_NOT_FOUND", message: "Imported session not found." },
      404,
    );
  }
  return c.json({ code: domainError.code, message: domainError.message }, 409);
}

function routeError(c: Context, error: unknown): Response {
  const domainResponse = archivedSessionImportErrorResponse(c, error);
  if (domainResponse) return domainResponse;
  if (error instanceof InvalidSessionImportRequestError) {
    return c.json(
      {
        code: "INVALID_SESSION_IMPORT_REQUEST",
        message: "Invalid archived session import request.",
      },
      422,
    );
  }
  if (error instanceof SessionTenancyManagedHumanRequiredError) {
    return c.json(
      {
        code: "SESSION_IMPORT_FORBIDDEN",
        message: "Private imports require an authenticated owning user.",
      },
      403,
    );
  }
  if (error instanceof SessionTenancyNotActivatedError) {
    return c.json(
      {
        code: "SESSION_TENANCY_NOT_ACTIVATED",
        message: "Private sessions are not enabled for this organization.",
      },
      409,
    );
  }
  if (error instanceof SessionAuthorizationDeniedError) {
    return c.json(
      { code: "SESSION_IMPORT_NOT_FOUND", message: "Imported session not found." },
      404,
    );
  }
  if (error instanceof SessionAuthorizationUnavailableError) {
    throw new HTTPException(503, { message: "Session authorization is unavailable" });
  }
  throw error;
}

export function registerSessionHistoryImportRoutes(app: Hono, deps: ApiRouteDeps): void {
  for (const base of [
    "/v1/workspaces/:workspaceId/session-imports",
    "/v1/workspaces/external/:source/:externalId/session-imports",
  ]) {
    app.post(base, async (c) => {
      try {
        const workspaceId = await resolveWorkspace(c, deps);
        const authorization = await authorize(c, deps, workspaceId, "sessions:create");
        const parsed = ImportArchivedSessionRequest.safeParse(
          await readSessionHistoryImportJson(c.req.raw),
        );
        if (!parsed.success) throw new InvalidSessionImportRequestError();
        const response = await importArchivedSessionForRequest(
          deps,
          authorization,
          workspaceId,
          parsed.data,
        );
        return c.json(response, response.created ? 201 : 200);
      } catch (error) {
        return routeError(c, error);
      }
    });
    app.post(`${base}/:importId/events`, async (c) => {
      try {
        const workspaceId = await resolveWorkspace(c, deps);
        const authorization = await authorize(c, deps, workspaceId, "sessions:control");
        const importId = c.req.param("importId");
        if (!importId || importId.length > 200) throw new InvalidSessionImportRequestError();
        const parsed = AppendArchivedSessionEventsRequest.safeParse(
          await readSessionHistoryImportJson(c.req.raw),
        );
        if (!parsed.success) throw new InvalidSessionImportRequestError();
        return c.json(
          await appendArchivedSessionEventsForRequest(
            deps,
            authorization,
            workspaceId,
            importId,
            parsed.data,
          ),
        );
      } catch (error) {
        return routeError(c, error);
      }
    });
  }
}
