import { randomUUID } from "node:crypto";
import {
  ActivateWorkspaceLearningPolicyRevisionRequest,
  CreateWorkspaceLearningPolicyRevisionRequest,
  RollbackWorkspaceLearningPolicyRevisionRequest,
  UndoGovernedLearningActivationHttpRequest,
  WorkspaceLearningHistoryResponse,
  WorkspaceLearningPolicyHistoryQuery,
  WorkspaceLearningPolicyMutationResponse,
  WorkspaceLearningPolicyRevision,
} from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  activateWorkspaceLearningPolicyRevision,
  createWorkspaceLearningPolicyRevision,
  GovernedLearningActivationAuthorityError,
  GovernedLearningActivationConflictError,
  GovernedLearningActivationInvalidOperationError,
  GovernedLearningEvaluationAuthorityError,
  listGovernedLearningActivationHistory,
  listGovernedLearningDecisionReceipts,
  listWorkspaceLearningPolicyHistory,
  rollbackWorkspaceLearningPolicyRevision,
  undoGovernedLearningActivation,
  WorkspaceLearningPolicyAuthorityError,
  WorkspaceLearningPolicyConflictError,
  WorkspaceLearningPolicyInvalidOperationError,
  WorkspaceLearningPolicyNotFoundError,
  WorkspaceLearningPolicyOperationReuseError,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

async function parseBody<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(422, { message: "Invalid workspace learning request" });
  }
  return parsed.data;
}

function learningError(error: unknown): never {
  if (
    error instanceof WorkspaceLearningPolicyAuthorityError ||
    error instanceof GovernedLearningEvaluationAuthorityError ||
    error instanceof GovernedLearningActivationAuthorityError
  ) {
    throw new HTTPException(403, { message: error.message });
  }
  if (error instanceof WorkspaceLearningPolicyNotFoundError) {
    throw new HTTPException(404, { message: error.message });
  }
  if (
    error instanceof WorkspaceLearningPolicyConflictError ||
    error instanceof WorkspaceLearningPolicyOperationReuseError ||
    error instanceof GovernedLearningActivationConflictError
  ) {
    throw new HTTPException(409, { message: error.message });
  }
  if (
    error instanceof WorkspaceLearningPolicyInvalidOperationError ||
    error instanceof GovernedLearningActivationInvalidOperationError
  ) {
    throw new HTTPException(422, { message: error.message });
  }
  throw error;
}

export function registerWorkspaceLearningRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/learning";

  app.get(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const query = WorkspaceLearningPolicyHistoryQuery.safeParse({
      limit: context.req.query("limit"),
    });
    if (!query.success) {
      throw new HTTPException(422, { message: "Invalid workspace learning history query" });
    }
    try {
      const [policy, decisions, lifecycle] = await Promise.all([
        listWorkspaceLearningPolicyHistory(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          limit: query.data.limit,
        }),
        listGovernedLearningDecisionReceipts(deps.db, {
          workspaceId,
          subjectId: grant.subjectId,
          principalKind: grant.principalKind ?? "",
          limit: query.data.limit,
        }),
        listGovernedLearningActivationHistory(deps.db, {
          workspaceId,
          subjectId: grant.subjectId,
          principalKind: grant.principalKind ?? "",
          limit: query.data.limit,
        }),
      ]);
      return context.json(
        WorkspaceLearningHistoryResponse.parse({
          head: policy.head,
          revisions: policy.revisions,
          policyEvents: policy.events,
          decisions: decisions.receipts,
          activations: lifecycle.activations,
          undos: lifecycle.undos,
          truncated: policy.truncated || decisions.truncated || lifecycle.truncated,
          effectiveBoundary: "next_accepted_attempt",
        }),
      );
    } catch (error) {
      learningError(error);
    }
  });

  app.post(`${base}/revisions`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:admin");
    const request = await parseBody(context, CreateWorkspaceLearningPolicyRevisionRequest);
    try {
      return context.json(
        WorkspaceLearningPolicyRevision.parse(
          await createWorkspaceLearningPolicyRevision(deps.db, {
            operationId: request.operationId ?? randomUUID(),
            accountId: grant.accountId,
            workspaceId,
            workspaceMode: request.workspaceMode,
            sourceOverrides: request.sourceOverrides,
            supersedesRevisionId: request.supersedesRevisionId,
            actorSubjectId: grant.subjectId,
            principalKind: grant.principalKind,
          }),
        ),
        201,
      );
    } catch (error) {
      learningError(error);
    }
  });

  app.post(`${base}/revisions/:revisionId/activate`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const revisionId = z.string().uuid().safeParse(context.req.param("revisionId"));
    if (!revisionId.success) throw new HTTPException(422, { message: "Invalid revision id" });
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:admin");
    const request = await parseBody(context, ActivateWorkspaceLearningPolicyRevisionRequest);
    try {
      return context.json(
        WorkspaceLearningPolicyMutationResponse.parse(
          await activateWorkspaceLearningPolicyRevision(deps.db, {
            operationId: request.operationId ?? randomUUID(),
            accountId: grant.accountId,
            workspaceId,
            revisionId: revisionId.data,
            expectedCurrentRevisionId: request.expectedCurrentRevisionId,
            expectedActivationVersion: request.expectedActivationVersion,
            actorSubjectId: grant.subjectId,
            principalKind: grant.principalKind,
            reason: request.reason,
          }),
        ),
      );
    } catch (error) {
      learningError(error);
    }
  });

  app.post(`${base}/rollback`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:admin");
    const request = await parseBody(context, RollbackWorkspaceLearningPolicyRevisionRequest);
    try {
      return context.json(
        WorkspaceLearningPolicyMutationResponse.parse(
          await rollbackWorkspaceLearningPolicyRevision(deps.db, {
            operationId: request.operationId ?? randomUUID(),
            accountId: grant.accountId,
            workspaceId,
            targetRevisionId: request.targetRevisionId,
            expectedCurrentRevisionId: request.expectedCurrentRevisionId,
            expectedActivationVersion: request.expectedActivationVersion,
            actorSubjectId: grant.subjectId,
            principalKind: grant.principalKind,
            reason: request.reason,
          }),
        ),
      );
    } catch (error) {
      learningError(error);
    }
  });

  app.post(`${base}/activations/:activationReceiptId/undo`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const activationReceiptId = z
      .string()
      .uuid()
      .safeParse(context.req.param("activationReceiptId"));
    if (!activationReceiptId.success) {
      throw new HTTPException(422, { message: "Invalid activation receipt id" });
    }
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:admin");
    const request = await parseBody(context, UndoGovernedLearningActivationHttpRequest);
    try {
      return context.json(
        await undoGovernedLearningActivation(deps.db, {
          caller: { workspaceId, subjectId: grant.subjectId },
          request: {
            operationId: request.operationId ?? randomUUID(),
            activationReceiptId: activationReceiptId.data,
          },
        }),
      );
    } catch (error) {
      learningError(error);
    }
  });
}
