import { randomUUID } from "node:crypto";
import {
  UndoGovernedLearningActivationHttpRequest,
  WorkspaceLearningHistoryResponse,
  WorkspaceLearningPolicyHistoryQuery,
} from "@opengeni/contracts";
import {
  publishGovernedLearningEventToSlack,
  requireAccessGrant,
  requireWorkspaceSettingsGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  GovernedLearningActivationAuthorityError,
  GovernedLearningActivationConflictError,
  GovernedLearningActivationInvalidOperationError,
  GovernedLearningEvaluationAuthorityError,
  listGovernedLearningActivationHistory,
  listGovernedLearningDecisionReceipts,
  listWorkspaceLearningPolicyHistory,
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

  for (const path of ["/revisions", "/revisions/:revisionId/activate", "/rollback"]) {
    app.post(`${base}${path}`, async (context) => {
      await requireWorkspaceSettingsGrant(context, deps, context.req.param("workspaceId")!);
      return context.json(
        {
          error: {
            code: "learning_settings_replaced",
            message: "Configure Knowledge, instructions and Skills in Agent learning settings.",
          },
        },
        410,
      );
    });
  }

  app.post(`${base}/activations/:activationReceiptId/undo`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const activationReceiptId = z
      .string()
      .uuid()
      .safeParse(context.req.param("activationReceiptId"));
    if (!activationReceiptId.success) {
      throw new HTTPException(422, { message: "Invalid activation receipt id" });
    }
    const grant = await requireWorkspaceSettingsGrant(context, deps, workspaceId);
    const request = await parseBody(context, UndoGovernedLearningActivationHttpRequest);
    try {
      const undo = await undoGovernedLearningActivation(deps.db, {
        caller: { workspaceId, subjectId: grant.subjectId },
        request: {
          operationId: request.operationId ?? randomUUID(),
          activationReceiptId: activationReceiptId.data,
        },
      });
      // Best-effort notification; the undo receipt is already durable.
      await publishGovernedLearningEventToSlack(deps.db, { kind: "undone", receipt: undo }).catch(
        () => undefined,
      );
      return context.json(undo);
    } catch (error) {
      learningError(error);
    }
  });
}
