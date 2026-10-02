import { randomUUID } from "node:crypto";
import {
  SlackTaskPolicyListResponse,
  SlackTaskPolicyMutationResponse,
  UpdateSlackTaskPolicyRequest,
} from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  listSlackTaskPolicy,
  SlackTaskPolicyAuthorityError,
  SlackTaskPolicyConflictError,
  SlackTaskPolicyInvalidOperationError,
  SlackTaskPolicyOperationReuseError,
  updateSlackTaskPolicy,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireUserOrOrganizationRouteAuthorization } from "../http/human-route-authorization";

function policyError(context: Context, error: unknown): Response {
  if (error instanceof SlackTaskPolicyConflictError) {
    return context.json(
      { code: error.code, message: error.message, currentHead: error.currentHead },
      409,
    );
  }
  if (error instanceof SlackTaskPolicyOperationReuseError) {
    return context.json({ code: error.code, message: error.message }, 409);
  }
  if (error instanceof SlackTaskPolicyAuthorityError) {
    return context.json(
      { code: "SLACK_TASK_POLICY_AUTHORITY_REQUIRED", message: error.message },
      403,
    );
  }
  if (error instanceof SlackTaskPolicyInvalidOperationError) {
    return context.json(
      { code: "INVALID_SLACK_TASK_POLICY_OPERATION", message: error.message },
      422,
    );
  }
  throw error;
}

export function registerSlackTaskPolicyRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/slack-task-policy";

  app.get(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    return context.json(
      SlackTaskPolicyListResponse.parse(
        await listSlackTaskPolicy(deps.db, {
          accountId: grant.accountId,
          workspaceId,
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
      "workspace:admin",
    );
    requireUserOrOrganizationRouteAuthorization(access);
    const parsed = UpdateSlackTaskPolicyRequest.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      throw new HTTPException(422, { message: "Invalid Slack task-policy request" });
    try {
      return context.json(
        SlackTaskPolicyMutationResponse.parse(
          await updateSlackTaskPolicy(deps.db, {
            operationId: parsed.data.operationId ?? randomUUID(),
            accountId: access.grant.accountId,
            workspaceId,
            policy: parsed.data.policy,
            expectedCurrentRevisionId: parsed.data.expectedCurrentRevisionId,
            expectedActivationVersion: parsed.data.expectedActivationVersion,
            actorSubjectId: access.grant.subjectId,
            principalKind: "human_session",
            reason: parsed.data.reason,
          }),
        ),
      );
    } catch (error) {
      return policyError(context, error);
    }
  });
}
