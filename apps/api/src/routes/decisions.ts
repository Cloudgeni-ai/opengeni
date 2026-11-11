import { ModelDecisionRequest } from "@opengeni/contracts";
import { ModelCallError, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { Hono } from "hono";
import { chatCompletionError } from "../model-calls/chat-completions";
import { isModelCallAbort, publicModelCallError } from "../model-calls/service";

export function registerDecisionRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.post("/v1/workspaces/:workspaceId/decisions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    try {
      if (!deps.decisions)
        throw new ModelCallError({
          status: 503,
          type: "service_unavailable",
          code: "unavailable",
          message: "Decisions are unavailable on this deployment.",
        });
      const parsed = ModelDecisionRequest.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        throw new ModelCallError({
          status: 400,
          type: "invalid_request_error",
          code: "invalid_value",
          param: issue.path.join(".") || null,
          message: issue.message,
        });
      }
      return c.json(
        await deps.decisions.decide({
          grant,
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          requestId: crypto.randomUUID(),
          signal: c.req.raw.signal,
          request: parsed.data as ModelDecisionRequest,
        }),
      );
    } catch (error) {
      if (isModelCallAbort(error)) return c.body(null, 499 as never);
      const mapped = publicModelCallError(error) as ModelCallError;
      return c.json(chatCompletionError(mapped), mapped.status as never);
    }
  });
}
