import {
  ActivateWorkspaceInstructionPolicyRequest,
  CreateWorkspaceInstructionPolicyDraftRequest,
  ImportLegacyWorkspaceInstructionPolicyDraftRequest,
  RollbackWorkspaceInstructionPolicyRequest,
  WorkspaceInstructionPolicyActivationResponse,
  WorkspaceInstructionPolicyConflictResponse,
  WorkspaceInstructionPolicyDiffRequest,
  WorkspaceInstructionPolicyDiffResponse,
  WorkspaceInstructionPolicyListQuery,
  WorkspaceInstructionPolicyListResponse,
  WorkspaceInstructionPolicyRevision,
} from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  activateWorkspaceInstructionPolicyRevision,
  createWorkspaceInstructionPolicyDraft,
  diffWorkspaceInstructionPolicyRevisions,
  getWorkspaceInstructionPolicyRevision,
  importLegacyWorkspaceInstructionPolicyDraft,
  listWorkspaceInstructionPolicyRevisions,
  rollbackWorkspaceInstructionPolicyRevision,
  WorkspaceInstructionPolicyConflictError,
  WorkspaceInstructionPolicyInvalidOperationError,
  WorkspaceInstructionPolicyLegacyUnavailableError,
  WorkspaceInstructionPolicyNotFoundError,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const WorkspaceInstructionPolicyRevisionId = z.string().uuid();

async function parseBody<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(422, { message: "Invalid workspace instruction-policy request" });
  }
  return parsed.data;
}

function policyErrorResponse(context: Context, error: unknown): Response {
  if (error instanceof WorkspaceInstructionPolicyConflictError) {
    return context.json(
      WorkspaceInstructionPolicyConflictResponse.parse({
        code: error.code,
        message: error.message,
        currentHead: error.currentHead,
      }),
      409,
    );
  }
  if (error instanceof WorkspaceInstructionPolicyNotFoundError) {
    return context.json(
      { code: "WORKSPACE_INSTRUCTION_POLICY_NOT_FOUND", message: error.message },
      404,
    );
  }
  if (error instanceof WorkspaceInstructionPolicyLegacyUnavailableError) {
    return context.json(
      { code: "WORKSPACE_INSTRUCTION_POLICY_LEGACY_UNAVAILABLE", message: error.message },
      409,
    );
  }
  if (error instanceof WorkspaceInstructionPolicyInvalidOperationError) {
    return context.json(
      { code: "INVALID_WORKSPACE_INSTRUCTION_POLICY_OPERATION", message: error.message },
      422,
    );
  }
  throw error;
}

function assertBoundedActor(subjectId: string): void {
  if (subjectId.trim().length < 1 || subjectId.length > 1_024) {
    throw new HTTPException(400, { message: "Workspace instruction-policy actor is invalid" });
  }
}

function parseRevisionId(context: Context): string {
  const parsed = WorkspaceInstructionPolicyRevisionId.safeParse(context.req.param("revisionId"));
  if (!parsed.success) {
    throw new HTTPException(422, { message: "Invalid workspace instruction-policy revision id" });
  }
  return parsed.data;
}

export function registerWorkspaceInstructionPolicyRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/instruction-policies";

  app.get(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const parsed = WorkspaceInstructionPolicyListQuery.safeParse({
      kind: context.req.query("kind"),
      scope: context.req.query("scope"),
      roleKey: context.req.query("roleKey"),
      afterRevision: context.req.query("afterRevision"),
      limit: context.req.query("limit"),
    });
    if (!parsed.success) {
      throw new HTTPException(422, { message: "Invalid workspace instruction-policy query" });
    }
    return context.json(
      WorkspaceInstructionPolicyListResponse.parse(
        await listWorkspaceInstructionPolicyRevisions(deps.db, workspaceId, parsed.data),
      ),
    );
  });

  app.post(`${base}/drafts`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:admin");
    assertBoundedActor(grant.subjectId);
    const request = await parseBody(context, CreateWorkspaceInstructionPolicyDraftRequest);
    try {
      return context.json(
        WorkspaceInstructionPolicyRevision.parse(
          await createWorkspaceInstructionPolicyDraft(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            createdBySubjectId: grant.subjectId,
            kind: request.kind,
            scope: request.scope,
            roleKey: request.roleKey,
            content: request.content,
            provenanceSource: request.provenanceSource,
            provenanceSourceId: request.provenanceSourceId,
            supersedesRevisionId: request.supersedesRevisionId,
          }),
        ),
        201,
      );
    } catch (error) {
      return policyErrorResponse(context, error);
    }
  });

  app.post(`${base}/import-legacy`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:admin");
    assertBoundedActor(grant.subjectId);
    const request = await parseBody(context, ImportLegacyWorkspaceInstructionPolicyDraftRequest);
    try {
      return context.json(
        WorkspaceInstructionPolicyRevision.parse(
          await importLegacyWorkspaceInstructionPolicyDraft(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            createdBySubjectId: grant.subjectId,
            supersedesRevisionId: request.supersedesRevisionId,
          }),
        ),
        201,
      );
    } catch (error) {
      return policyErrorResponse(context, error);
    }
  });

  app.get(`${base}/diff`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const parsed = WorkspaceInstructionPolicyDiffRequest.safeParse({
      fromRevisionId: context.req.query("fromRevisionId"),
      toRevisionId: context.req.query("toRevisionId"),
    });
    if (!parsed.success) {
      throw new HTTPException(422, { message: "Invalid workspace instruction-policy diff query" });
    }
    try {
      return context.json(
        WorkspaceInstructionPolicyDiffResponse.parse(
          await diffWorkspaceInstructionPolicyRevisions(deps.db, workspaceId, parsed.data),
        ),
      );
    } catch (error) {
      return policyErrorResponse(context, error);
    }
  });

  app.post(`${base}/rollback`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:admin");
    assertBoundedActor(grant.subjectId);
    const request = await parseBody(context, RollbackWorkspaceInstructionPolicyRequest);
    try {
      return context.json(
        WorkspaceInstructionPolicyActivationResponse.parse(
          await rollbackWorkspaceInstructionPolicyRevision(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            targetRevisionId: request.targetRevisionId,
            expectedCurrentRevisionId: request.expectedCurrentRevisionId,
            actorSubjectId: grant.subjectId,
            reason: request.reason,
          }),
        ),
      );
    } catch (error) {
      return policyErrorResponse(context, error);
    }
  });

  app.get(`${base}/:revisionId`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const revisionId = parseRevisionId(context);
    try {
      return context.json(
        WorkspaceInstructionPolicyRevision.parse(
          await getWorkspaceInstructionPolicyRevision(deps.db, workspaceId, revisionId),
        ),
      );
    } catch (error) {
      return policyErrorResponse(context, error);
    }
  });

  app.post(`${base}/:revisionId/activate`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:admin");
    assertBoundedActor(grant.subjectId);
    const revisionId = parseRevisionId(context);
    const request = await parseBody(context, ActivateWorkspaceInstructionPolicyRequest);
    try {
      return context.json(
        WorkspaceInstructionPolicyActivationResponse.parse(
          await activateWorkspaceInstructionPolicyRevision(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            revisionId,
            expectedCurrentRevisionId: request.expectedCurrentRevisionId,
            actorSubjectId: grant.subjectId,
            reason: request.reason,
          }),
        ),
      );
    } catch (error) {
      return policyErrorResponse(context, error);
    }
  });
}
