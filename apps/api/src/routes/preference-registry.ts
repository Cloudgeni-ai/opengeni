import {
  ActivatePreferenceRegistryRevisionRequest,
  ChangePreferenceRegistryScopeRequest,
  CorrectPreferenceRegistryRequest,
  CreatePreferenceRegistryProposalRequest,
  DeactivatePreferenceRegistryRequest,
  PreferenceRegistryConflictResponse,
  PreferenceRegistryDetailResponse,
  PreferenceRegistryFullContentRequest,
  PreferenceRegistryFullContent,
  PreferenceRegistryListQuery,
  PreferenceRegistryListResponse,
  PreferenceRegistryMutationResponse,
  PreferenceRegistryRecord,
  PreferenceRegistrySnapshot,
  RejectPreferenceRegistryProposalRequest,
  SupersedePreferenceRegistryRequest,
  type AccessGrant,
  type PreferenceRegistryScope,
} from "@opengeni/contracts";
import { hasPermission, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  activatePreferenceRegistryRevision,
  changePreferenceRegistryScope,
  correctPreferenceRegistry,
  createPreferenceRegistryProposal,
  deactivatePreferenceRegistry,
  getOrCreatePreferenceRegistrySnapshot,
  getPreferenceRegistryDetail,
  getPreferenceRegistryDetailForAttempt,
  getPreferenceRegistryFullContent,
  listPreferenceRegistry,
  listPreferenceRegistryForAttempt,
  PreferenceRegistryConflictError,
  PreferenceRegistryInitiatorError,
  PreferenceRegistryInvalidOperationError,
  PreferenceRegistryNotFoundError,
  PreferenceRegistryStableKeyConflictError,
  rejectPreferenceRegistryProposal,
  supersedePreferenceRegistry,
  type PreferenceRegistryAttemptClaims,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const Id = z.string().uuid();

async function parseBody<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success)
    throw new HTTPException(422, { message: "Invalid preference registry request" });
  return parsed.data;
}

function exactAttemptClaims(grant: AccessGrant) {
  const metadata = grant.metadata ?? {};
  const values = {
    sessionId: metadata["sessionId"],
    turnId: metadata["turnId"],
    attemptId: metadata["attemptId"],
    executionGeneration: metadata["executionGeneration"],
  };
  const present = Object.values(values).filter((value) => value !== undefined).length;
  if (present === 0) return null;
  if (
    typeof values.sessionId !== "string" ||
    typeof values.turnId !== "string" ||
    typeof values.attemptId !== "string" ||
    typeof values.executionGeneration !== "number" ||
    !Number.isSafeInteger(values.executionGeneration) ||
    values.executionGeneration < 1 ||
    values.executionGeneration > 2_147_483_647
  ) {
    throw new HTTPException(403, { message: "Incomplete signed preference attempt authority" });
  }
  return values as {
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
  };
}

function requiredAttemptClaims(grant: AccessGrant): PreferenceRegistryAttemptClaims {
  const claims = exactAttemptClaims(grant);
  if (!claims) {
    throw new HTTPException(403, {
      message: "Preference snapshot retrieval requires a signed session, turn, and attempt",
    });
  }
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ...claims,
  };
}

function requireHumanMutation(grant: AccessGrant): void {
  if (
    grant.principalKind !== "human_session" ||
    exactAttemptClaims(grant) !== null ||
    grant.serviceInitiator ||
    grant.subjectId.startsWith("api_key:")
  ) {
    throw new HTTPException(403, {
      message: "Preference activation and scope mutation require a direct human-authorized request",
    });
  }
}

function requireScopeManage(grant: AccessGrant, scope: PreferenceRegistryScope): void {
  requireHumanMutation(grant);
  if (scope === "organization") {
    // Deliberately do not use hasPermission: workspace:admin must not expand to
    // account:admin for an organization-wide preference.
    if (!grant.permissions.includes("account:admin")) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    return;
  }
  if (scope === "workspace" && !hasPermission(grant.permissions, "workspace:admin")) {
    throw new HTTPException(403, { message: "missing permission: workspace:admin" });
  }
  // User scope is always self-only: the route derives the target from the
  // authenticated actor and never accepts a subject selector.
}

function preferenceError(context: Context, error: unknown): Response {
  if (error instanceof PreferenceRegistryConflictError) {
    return context.json(
      PreferenceRegistryConflictResponse.parse({
        code: error.code,
        message: error.message,
        currentRevisionId: error.currentRevisionId,
        scopeVersion: error.scopeVersion,
      }),
      409,
    );
  }
  if (error instanceof PreferenceRegistryNotFoundError) {
    return context.json({ code: "PREFERENCE_REGISTRY_NOT_FOUND", message: error.message }, 404);
  }
  if (error instanceof PreferenceRegistryStableKeyConflictError) {
    return context.json({ code: error.code, message: error.message }, 409);
  }
  if (error instanceof PreferenceRegistryInvalidOperationError) {
    return context.json(
      { code: "INVALID_PREFERENCE_REGISTRY_OPERATION", message: error.message },
      422,
    );
  }
  if (error instanceof PreferenceRegistryInitiatorError) {
    return context.json(
      { code: "PREFERENCE_REGISTRY_ATTEMPT_REJECTED", message: error.message },
      403,
    );
  }
  throw error;
}

function preferenceId(context: Context): string {
  const parsed = Id.safeParse(context.req.param("preferenceId"));
  if (!parsed.success) throw new HTTPException(422, { message: "Invalid preference id" });
  return parsed.data;
}

export function registerPreferenceRegistryRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/preferences";

  app.get(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const query = PreferenceRegistryListQuery.safeParse({
      scope: context.req.query("scope"),
      status: context.req.query("status"),
      limit: context.req.query("limit"),
    });
    if (!query.success)
      throw new HTTPException(422, { message: "Invalid preference registry query" });
    try {
      const claims = exactAttemptClaims(grant);
      const result = claims
        ? await listPreferenceRegistryForAttempt(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            ...claims,
            ...query.data,
          })
        : await listPreferenceRegistry(deps.db, {
            workspaceId,
            subjectId: grant.subjectId,
            ...query.data,
          });
      return context.json(PreferenceRegistryListResponse.parse(result));
    } catch (error) {
      return preferenceError(context, error);
    }
  });

  app.post(`${base}/proposals`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const request = await parseBody(context, CreatePreferenceRegistryProposalRequest);
    requireScopeManage(grant, request.scope);
    try {
      return context.json(
        PreferenceRegistryRecord.parse(
          await createPreferenceRegistryProposal(deps.db, {
            ...request,
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            principalKind: grant.principalKind,
          }),
        ),
        201,
      );
    } catch (error) {
      return preferenceError(context, error);
    }
  });

  app.get(`${base}/summary`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    try {
      return context.json(
        PreferenceRegistrySnapshot.parse(
          await getOrCreatePreferenceRegistrySnapshot(deps.db, requiredAttemptClaims(grant)),
        ),
      );
    } catch (error) {
      return preferenceError(context, error);
    }
  });

  app.post(`${base}/full-content`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const request = await parseBody(context, PreferenceRegistryFullContentRequest);
    try {
      return context.json(
        PreferenceRegistryFullContent.parse(
          await getPreferenceRegistryFullContent(
            deps.db,
            requiredAttemptClaims(grant),
            request.retrievalHandle,
          ),
        ),
      );
    } catch (error) {
      return preferenceError(context, error);
    }
  });

  app.get(`${base}/:preferenceId`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    try {
      const claims = exactAttemptClaims(grant);
      const id = preferenceId(context);
      const detail = claims
        ? await getPreferenceRegistryDetailForAttempt(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            ...claims,
            preferenceId: id,
          })
        : await getPreferenceRegistryDetail(deps.db, {
            workspaceId,
            subjectId: grant.subjectId,
            preferenceId: id,
          });
      return context.json(PreferenceRegistryDetailResponse.parse(detail));
    } catch (error) {
      return preferenceError(context, error);
    }
  });

  app.post(`${base}/:preferenceId/activate`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const id = preferenceId(context);
    const request = await parseBody(context, ActivatePreferenceRegistryRevisionRequest);
    try {
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await activatePreferenceRegistryRevision(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            principalKind: grant.principalKind,
            preferenceId: id,
            authorizeScope: (scope) => requireScopeManage(grant, scope),
            ...request,
          }),
        ),
      );
    } catch (error) {
      return preferenceError(context, error);
    }
  });

  app.post(`${base}/:preferenceId/correct`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const id = preferenceId(context);
    const request = await parseBody(context, CorrectPreferenceRegistryRequest);
    try {
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await correctPreferenceRegistry(deps.db, {
            ...request,
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            principalKind: grant.principalKind,
            preferenceId: id,
            authorizeScope: (scope) => requireScopeManage(grant, scope),
          }),
        ),
      );
    } catch (error) {
      return preferenceError(context, error);
    }
  });

  app.post(`${base}/:preferenceId/scope`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const id = preferenceId(context);
    const request = await parseBody(context, ChangePreferenceRegistryScopeRequest);
    try {
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await changePreferenceRegistryScope(deps.db, {
            ...request,
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            principalKind: grant.principalKind,
            preferenceId: id,
            authorizeScope: (scope) => requireScopeManage(grant, scope),
          }),
        ),
      );
    } catch (error) {
      return preferenceError(context, error);
    }
  });

  app.post(`${base}/:preferenceId/deactivate`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const id = preferenceId(context);
    const request = await parseBody(context, DeactivatePreferenceRegistryRequest);
    try {
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await deactivatePreferenceRegistry(deps.db, {
            ...request,
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            principalKind: grant.principalKind,
            preferenceId: id,
            authorizeScope: (scope) => requireScopeManage(grant, scope),
          }),
        ),
      );
    } catch (error) {
      return preferenceError(context, error);
    }
  });

  app.post(`${base}/:preferenceId/supersede`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const id = preferenceId(context);
    const request = await parseBody(context, SupersedePreferenceRegistryRequest);
    try {
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await supersedePreferenceRegistry(deps.db, {
            ...request,
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            principalKind: grant.principalKind,
            preferenceId: id,
            authorizeScope: (scope) => requireScopeManage(grant, scope),
          }),
        ),
      );
    } catch (error) {
      return preferenceError(context, error);
    }
  });

  app.post(`${base}/:preferenceId/reject`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const id = preferenceId(context);
    const request = await parseBody(context, RejectPreferenceRegistryProposalRequest);
    try {
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await rejectPreferenceRegistryProposal(deps.db, {
            ...request,
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            principalKind: grant.principalKind,
            preferenceId: id,
            authorizeScope: (scope) => requireScopeManage(grant, scope),
          }),
        ),
      );
    } catch (error) {
      return preferenceError(context, error);
    }
  });
}
