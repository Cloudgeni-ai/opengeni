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
  getPreferenceRegistryFullContent,
  listPreferenceRegistry,
  PreferenceRegistryConflictError,
  PreferenceRegistryInitiatorError,
  PreferenceRegistryInvalidOperationError,
  PreferenceRegistryNotFoundError,
  PreferenceRegistryStableKeyConflictError,
  rejectPreferenceRegistryProposal,
  resolvePreferenceRegistryAttemptAuthority,
  supersedePreferenceRegistry,
  type PreferenceRegistryAttemptAuthority,
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
    typeof values.executionGeneration !== "number"
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

async function attemptAuthority(
  deps: ApiRouteDeps,
  grant: AccessGrant,
): Promise<PreferenceRegistryAttemptAuthority> {
  const claims = exactAttemptClaims(grant);
  if (!claims) {
    throw new HTTPException(403, {
      message: "Preference snapshot retrieval requires a signed session, turn, and attempt",
    });
  }
  try {
    return await resolvePreferenceRegistryAttemptAuthority(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      ...claims,
    });
  } catch (error) {
    if (error instanceof PreferenceRegistryInitiatorError) {
      throw new HTTPException(403, { message: error.message });
    }
    throw error;
  }
}

async function visibleSubject(deps: ApiRouteDeps, grant: AccessGrant): Promise<string> {
  return exactAttemptClaims(grant)
    ? (await attemptAuthority(deps, grant)).initiatingHumanSubjectId
    : grant.subjectId;
}

function requireHumanMutation(grant: AccessGrant): void {
  if (
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
    return context.json(
      PreferenceRegistryListResponse.parse(
        await listPreferenceRegistry(deps.db, {
          workspaceId,
          subjectId: await visibleSubject(deps, grant),
          ...query.data,
        }),
      ),
    );
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
    return context.json(
      PreferenceRegistrySnapshot.parse(
        await getOrCreatePreferenceRegistrySnapshot(deps.db, await attemptAuthority(deps, grant)),
      ),
    );
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
            await attemptAuthority(deps, grant),
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
      return context.json(
        PreferenceRegistryDetailResponse.parse(
          await getPreferenceRegistryDetail(deps.db, {
            workspaceId,
            subjectId: await visibleSubject(deps, grant),
            preferenceId: preferenceId(context),
          }),
        ),
      );
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
      const detail = await getPreferenceRegistryDetail(deps.db, {
        workspaceId,
        subjectId: grant.subjectId,
        preferenceId: id,
      });
      requireScopeManage(grant, detail.preference.target.scope);
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await activatePreferenceRegistryRevision(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            preferenceId: id,
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
      const detail = await getPreferenceRegistryDetail(deps.db, {
        workspaceId,
        subjectId: grant.subjectId,
        preferenceId: id,
      });
      requireScopeManage(grant, detail.preference.target.scope);
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await correctPreferenceRegistry(deps.db, {
            ...request,
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            preferenceId: id,
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
      const detail = await getPreferenceRegistryDetail(deps.db, {
        workspaceId,
        subjectId: grant.subjectId,
        preferenceId: id,
      });
      requireScopeManage(grant, detail.preference.target.scope);
      requireScopeManage(grant, request.scope);
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await changePreferenceRegistryScope(deps.db, {
            ...request,
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            preferenceId: id,
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
      const detail = await getPreferenceRegistryDetail(deps.db, {
        workspaceId,
        subjectId: grant.subjectId,
        preferenceId: id,
      });
      requireScopeManage(grant, detail.preference.target.scope);
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await deactivatePreferenceRegistry(deps.db, {
            ...request,
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            preferenceId: id,
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
      const detail = await getPreferenceRegistryDetail(deps.db, {
        workspaceId,
        subjectId: grant.subjectId,
        preferenceId: id,
      });
      requireScopeManage(grant, detail.preference.target.scope);
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await supersedePreferenceRegistry(deps.db, {
            ...request,
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            preferenceId: id,
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
      const detail = await getPreferenceRegistryDetail(deps.db, {
        workspaceId,
        subjectId: grant.subjectId,
        preferenceId: id,
      });
      requireScopeManage(grant, detail.preference.target.scope);
      return context.json(
        PreferenceRegistryMutationResponse.parse(
          await rejectPreferenceRegistryProposal(deps.db, {
            ...request,
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            preferenceId: id,
          }),
        ),
      );
    } catch (error) {
      return preferenceError(context, error);
    }
  });
}
