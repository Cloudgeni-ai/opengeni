import { randomUUID } from "node:crypto";
import {
  ActivateCompanyProfileRevisionRequest,
  CompanyProfileAgentPolicy,
  CompanyProfileConflictResponse,
  CompanyProfileDiffRequest,
  CompanyProfileDiffResponse,
  CompanyProfileListQuery,
  CompanyProfileListResponse,
  CompanyProfileMutationResponse,
  CompanyProfileOperationReuseResponse,
  CompanyProfileRevision,
  RollbackCompanyProfileRequest,
  UpdateCompanyProfileRequest,
  UpdateCompanyProfileAgentPolicyRequest,
} from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  activateCompanyProfileRevision,
  CompanyProfileAgentPolicyError,
  CompanyProfileConflictError,
  CompanyProfileInvalidOperationError,
  CompanyProfileNotFoundError,
  CompanyProfileOperationReuseError,
  diffCompanyProfileRevisions,
  getCompanyProfileRevision,
  getCompanyProfileAgentPolicy,
  listCompanyProfile,
  rollbackCompanyProfileRevision,
  updateCompanyProfile,
  updateCompanyProfileAgentPolicy,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const RevisionId = z.string().uuid();

async function parseBody<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(422, { message: "Invalid company-profile request" });
  return parsed.data;
}

export function requireDirectAccountAdmin(access: AccessGrantAuthorization): void {
  const { grant } = access;
  if (
    !access.contextIntegrity ||
    access.authenticatedSubjectId !== grant.subjectId ||
    grant.principalKind !== "human_session" ||
    grant.serviceInitiator ||
    grant.serviceInitiatorContext ||
    grant.subjectId.startsWith("api_key:")
  ) {
    throw new HTTPException(403, {
      message: "Company-profile administration requires a direct human-authorized request",
    });
  }
  if (!access.accountGrant?.permissions.includes("account:admin")) {
    throw new HTTPException(403, { message: "missing permission: account:admin" });
  }
}

function profileError(context: Context, error: unknown): Response {
  if (error instanceof CompanyProfileConflictError) {
    return context.json(
      CompanyProfileConflictResponse.parse({
        code: error.code,
        message: error.message,
        currentHead: error.currentHead,
      }),
      409,
    );
  }
  if (error instanceof CompanyProfileOperationReuseError) {
    return context.json(
      CompanyProfileOperationReuseResponse.parse({ code: error.code, message: error.message }),
      409,
    );
  }
  if (error instanceof CompanyProfileNotFoundError) {
    return context.json({ code: "COMPANY_PROFILE_NOT_FOUND", message: error.message }, 404);
  }
  if (error instanceof CompanyProfileInvalidOperationError) {
    return context.json({ code: "INVALID_COMPANY_PROFILE_OPERATION", message: error.message }, 422);
  }
  if (error instanceof CompanyProfileAgentPolicyError) {
    if (error.code === "authority_unavailable") {
      throw new HTTPException(403, { message: error.message });
    }
    if (error.code === "policy_conflict" || error.code === "operation_reused") {
      throw new HTTPException(409, { message: error.message });
    }
    throw new HTTPException(422, { message: error.message });
  }
  throw error;
}

function revisionId(context: Context): string {
  const parsed = RevisionId.safeParse(context.req.param("revisionId"));
  if (!parsed.success)
    throw new HTTPException(422, { message: "Invalid company-profile revision id" });
  return parsed.data;
}

export function registerCompanyProfileRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/company-profile";

  app.get(`${base}/agent-policy`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    requireDirectAccountAdmin(access);
    try {
      return context.json(
        CompanyProfileAgentPolicy.parse(
          await getCompanyProfileAgentPolicy(deps.db, {
            accountId: access.grant.accountId,
            workspaceId,
            actorSubjectId: access.grant.subjectId,
          }),
        ),
      );
    } catch (error) {
      return profileError(context, error);
    }
  });

  app.patch(`${base}/agent-policy`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    requireDirectAccountAdmin(access);
    const request = await parseBody(context, UpdateCompanyProfileAgentPolicyRequest);
    try {
      return context.json(
        CompanyProfileAgentPolicy.parse(
          await updateCompanyProfileAgentPolicy(deps.db, {
            accountId: access.grant.accountId,
            workspaceId,
            actorSubjectId: access.grant.subjectId,
            ...request,
          }),
        ),
      );
    } catch (error) {
      return profileError(context, error);
    }
  });

  app.get(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const query = CompanyProfileListQuery.safeParse({
      afterRevision: context.req.query("afterRevision"),
      limit: context.req.query("limit"),
    });
    if (!query.success) throw new HTTPException(422, { message: "Invalid company-profile query" });
    return context.json(
      CompanyProfileListResponse.parse(
        await listCompanyProfile(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          limit: query.data.limit,
          ...(query.data.afterRevision === undefined
            ? {}
            : { afterRevision: query.data.afterRevision }),
        }),
      ),
    );
  });

  app.put(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    requireDirectAccountAdmin(access);
    const request = await parseBody(context, UpdateCompanyProfileRequest);
    try {
      return context.json(
        CompanyProfileMutationResponse.parse(
          await updateCompanyProfile(deps.db, {
            operationId: request.operationId ?? randomUUID(),
            accountId: access.grant.accountId,
            workspaceId,
            profile: request.profile,
            expectedCurrentRevisionId: request.expectedCurrentRevisionId,
            expectedActivationVersion: request.expectedActivationVersion,
            actorSubjectId: access.grant.subjectId,
            principalKind: "human_session",
            reason: request.reason,
          }),
        ),
      );
    } catch (error) {
      return profileError(context, error);
    }
  });

  app.get(`${base}/diff`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const request = CompanyProfileDiffRequest.safeParse({
      fromRevisionId: context.req.query("fromRevisionId"),
      toRevisionId: context.req.query("toRevisionId"),
    });
    if (!request.success) throw new HTTPException(422, { message: "Invalid company-profile diff" });
    try {
      return context.json(
        CompanyProfileDiffResponse.parse(
          await diffCompanyProfileRevisions(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            ...request.data,
          }),
        ),
      );
    } catch (error) {
      return profileError(context, error);
    }
  });

  app.post(`${base}/rollback`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    requireDirectAccountAdmin(access);
    const request = await parseBody(context, RollbackCompanyProfileRequest);
    try {
      return context.json(
        CompanyProfileMutationResponse.parse(
          await rollbackCompanyProfileRevision(deps.db, {
            operationId: request.operationId ?? randomUUID(),
            accountId: access.grant.accountId,
            workspaceId,
            targetRevisionId: request.targetRevisionId,
            expectedCurrentRevisionId: request.expectedCurrentRevisionId,
            expectedActivationVersion: request.expectedActivationVersion,
            actorSubjectId: access.grant.subjectId,
            principalKind: "human_session",
            reason: request.reason,
          }),
        ),
      );
    } catch (error) {
      return profileError(context, error);
    }
  });

  app.get(`${base}/revisions/:revisionId`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    try {
      return context.json(
        CompanyProfileRevision.parse(
          await getCompanyProfileRevision(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            revisionId: revisionId(context),
          }),
        ),
      );
    } catch (error) {
      return profileError(context, error);
    }
  });

  app.post(`${base}/revisions/:revisionId/activate`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    requireDirectAccountAdmin(access);
    const request = await parseBody(context, ActivateCompanyProfileRevisionRequest);
    try {
      return context.json(
        CompanyProfileMutationResponse.parse(
          await activateCompanyProfileRevision(deps.db, {
            operationId: request.operationId ?? randomUUID(),
            accountId: access.grant.accountId,
            workspaceId,
            revisionId: revisionId(context),
            expectedCurrentRevisionId: request.expectedCurrentRevisionId,
            expectedActivationVersion: request.expectedActivationVersion,
            actorSubjectId: access.grant.subjectId,
            principalKind: "human_session",
            reason: request.reason,
          }),
        ),
      );
    } catch (error) {
      return profileError(context, error);
    }
  });
}
