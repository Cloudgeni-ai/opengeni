import { CreateFeedbackRequest } from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireSessionAuthorization,
  withResolvedSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createFeedback,
  listOwnFeedback,
  FeedbackConflictError,
  FeedbackTargetNotFoundError,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

export function registerFeedbackRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.post("/v1/workspaces/:workspaceId/feedback", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const parsed = CreateFeedbackRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new HTTPException(400, {
        message: parsed.error.issues[0]?.message ?? "Invalid feedback",
      });
    // Agent turns must not manufacture user satisfaction evidence. Product SDK
    // credentials are allowed but retain their own authenticated author/kind.
    if (
      grant.principalKind === "agent_attempt" ||
      grant.metadata?.["turnId"] !== undefined ||
      grant.metadata?.["attemptId"] !== undefined
    )
      throw new HTTPException(403, { message: "Agent attempts cannot submit feedback" });
    try {
      const save = () =>
        createFeedback(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          principalKind: grant.principalKind ?? null,
          request: parsed.data,
        });
      let result;
      if (parsed.data.sessionId) {
        await requireAccessGrant(c, deps, workspaceId, "sessions:read");
        const authorization = await requireSessionAuthorization(deps, grant, {
          sessionId: parsed.data.sessionId,
          operation: "session.feedback.write",
          surface: "http",
        });
        result = authorization
          ? await withResolvedSessionAuthorization(authorization, save)
          : await save();
      } else result = await save();
      c.header("cache-control", "private, no-store");
      return c.json(result, result.replayed ? 200 : 201);
    } catch (error) {
      throw feedbackHttpError(error);
    }
  });
  app.get("/v1/workspaces/:workspaceId/feedback", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const query = z
      .object({
        sessionId: z.string().uuid().optional(),
        includeTurns: z
          .enum(["true", "false"])
          .default("true")
          .transform((value) => value === "true"),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .safeParse(c.req.query());
    if (!query.success) throw new HTTPException(400, { message: "Invalid feedback query" });
    try {
      const read = () =>
        listOwnFeedback(deps.db, { workspaceId, subjectId: grant.subjectId, ...query.data });
      let feedback;
      if (query.data.sessionId) {
        await requireAccessGrant(c, deps, workspaceId, "sessions:read");
        const authorization = await requireSessionAuthorization(deps, grant, {
          sessionId: query.data.sessionId,
          operation: "session.read",
          surface: "http",
        });
        feedback = authorization
          ? await withResolvedSessionAuthorization(authorization, read)
          : await read();
      } else feedback = await read();
      c.header("cache-control", "private, no-store");
      return c.json({ feedback });
    } catch (error) {
      throw feedbackHttpError(error);
    }
  });
}
function feedbackHttpError(error: unknown): Error {
  if (error instanceof FeedbackConflictError)
    return new HTTPException(409, { message: error.message });
  if (
    error instanceof FeedbackTargetNotFoundError ||
    error instanceof SessionAuthorizationDeniedError
  )
    return new HTTPException(404, { message: "Feedback target not found" });
  if (error instanceof SessionAuthorizationUnavailableError)
    return new HTTPException(503, { message: "Session authorization unavailable" });
  if (error instanceof Error) return error;
  return new Error("Feedback request failed");
}
