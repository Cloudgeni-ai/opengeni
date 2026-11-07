import { ModelDecisionRequest, ModelEmbeddingsRequest } from "@opengeni/contracts";
import {
  ModelCallError,
  requireAccessGrant,
  type ApiRouteDeps,
  type AuxiliaryModelCallService,
} from "@opengeni/core";
import type { Hono, Context } from "hono";
import { chatCompletionError } from "../model-calls/chat-completions";
import { isModelCallAbort, publicModelCallError } from "../model-calls/service";

/** The same authenticated stateless-call authority as chat/completions. */
export function registerModelInferenceRoutes(
  app: Hono,
  deps: ApiRouteDeps & { auxiliaryModelCalls: AuxiliaryModelCallService | null },
): void {
  const handler = (kind: "decisions" | "embeddings") => async (c: Context) => {
    const workspaceId = c.req.param("workspaceId")!;
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    try {
      const service = deps.auxiliaryModelCalls;
      if (!service)
        throw new ModelCallError({
          status: 503,
          type: "service_unavailable",
          code: "unavailable",
          message: "Model calls are unavailable on this deployment.",
        });
      const body: unknown = await c.req.json().catch(() => undefined);
      const schema = kind === "decisions" ? ModelDecisionRequest : ModelEmbeddingsRequest;
      const parsed = schema.safeParse(body);
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
      const caller = {
        grant,
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        requestId: crypto.randomUUID(),
        signal: c.req.raw.signal,
      };
      return c.json(
        kind === "decisions"
          ? await service.decide({
              ...caller,
              request: parsed.data as ModelDecisionRequest,
            })
          : await service.embed({
              ...caller,
              request: parsed.data as ModelEmbeddingsRequest,
            }),
      );
    } catch (error) {
      if (isModelCallAbort(error)) return c.body(null, 499 as never);
      const mapped = publicModelCallError(error) as ModelCallError;
      return c.json(chatCompletionError(mapped), mapped.status as never);
    }
  };
  app.post("/v1/workspaces/:workspaceId/decisions", handler("decisions"));
  app.post("/v1/workspaces/:workspaceId/embeddings", handler("embeddings"));
}
