import {
  type ApiRouteDeps,
  ModelCallError,
  type ModelCallOutput,
  type ModelCallService,
  requireAccessGrant,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import {
  chatCompletionChunk,
  chatCompletionError,
  chatCompletionResponse,
  chatCompletionUsage,
  chatCompletionId,
  parseChatCompletionRequest,
} from "../model-calls/chat-completions";
import { isModelCallAbort } from "../model-calls/service";

/**
 * OpenAI-compatible stateless model calls. A stock OpenAI SDK works with its
 * base URL set to `/v1/workspaces/{workspaceId}` and an Opengeni API key.
 * Running one costs what the same model call costs inside a session, and
 * requires the same `sessions:create` authority.
 */
export function registerChatCompletionRoutes(
  app: Hono,
  deps: ApiRouteDeps & { modelCalls: ModelCallService | null },
): void {
  /** A public error, or null for a client abort (nothing left to answer). */
  const publicError = (error: unknown, workspaceId: string): ModelCallError | null => {
    if (error instanceof ModelCallError) return error;
    if (isModelCallAbort(error)) return null;
    deps.observability?.warn("chat completion failed unexpectedly", {
      workspaceId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return new ModelCallError({
      status: 500,
      type: "api_error",
      code: "internal_error",
      message: "The model call failed.",
    });
  };

  app.get("/v1/workspaces/:workspaceId/models", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    if (!deps.modelCalls) return errorResponse(c, unavailable());
    try {
      const models = await deps.modelCalls.listModels({
        grant,
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
      });
      return c.json({
        object: "list",
        data: models.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: model.providerLabel,
          name: model.label,
        })),
      });
    } catch (error) {
      return errorResponse(c, publicError(error, workspaceId));
    }
  });

  app.post("/v1/workspaces/:workspaceId/chat/completions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const service = deps.modelCalls;
    if (!service) return errorResponse(c, unavailable());
    let parsed: ReturnType<typeof parseChatCompletionRequest>;
    try {
      parsed = parseChatCompletionRequest(await c.req.json().catch(() => undefined));
    } catch (error) {
      return errorResponse(c, publicError(error, workspaceId));
    }
    // Server-generated: a client-chosen id would let a reused settlement key
    // make later calls free.
    const requestId = crypto.randomUUID();
    const created = Math.floor(Date.now() / 1000);
    const abort = new AbortController();
    const clientSignal = c.req.raw.signal;
    const onClientAbort = () => abort.abort();
    if (clientSignal.aborted) abort.abort();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
    const caller = {
      grant,
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      model: parsed.model,
      request: parsed.request,
      requestId,
      signal: abort.signal,
    };

    if (!parsed.stream) {
      try {
        const output = await service.call(caller);
        return c.json(
          chatCompletionResponse({
            requestId,
            created,
            model: output.model,
            result: output.result,
          }),
        );
      } catch (error) {
        return errorResponse(c, publicError(error, workspaceId));
      } finally {
        clientSignal.removeEventListener("abort", onClientAbort);
      }
    }

    // Streaming: the status is decided by the first model output. A refusal
    // or failure before any output is an ordinary JSON error response.
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
      cancel() {
        closed = true;
        abort.abort();
      },
    });
    const send = (payload: unknown) => {
      if (closed || !controller) return;
      const data = typeof payload === "string" ? payload : JSON.stringify(payload);
      controller.enqueue(encoder.encode(`data: ${data}\n\n`));
    };
    const close = () => {
      if (closed || !controller) return;
      closed = true;
      controller.close();
    };
    let model: string | null = null;
    let opened = false;
    let signalOpened!: () => void;
    const firstOutput = new Promise<void>((resolve) => {
      signalOpened = resolve;
    });
    const chunk = (
      delta: { role?: "assistant"; content?: string },
      finishReason: null | ModelCallOutput["result"]["finishReason"],
    ) =>
      chatCompletionChunk({
        requestId,
        created,
        model: model ?? parsed.model ?? "",
        delta,
        finishReason,
        includeUsage: parsed.includeUsage,
      });
    const open = () => {
      if (opened) return;
      opened = true;
      send(chunk({ role: "assistant", content: "" }, null));
      signalOpened();
    };
    const completion = service.call({
      ...caller,
      onTextDelta: (delta) => {
        open();
        send(chunk({ content: delta }, null));
      },
    });
    const first = await Promise.race([
      firstOutput.then(() => ({ kind: "output" as const })),
      completion.then(
        (output) => ({ kind: "done" as const, output }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
    ]);
    if (first.kind === "failed" && !opened) {
      clientSignal.removeEventListener("abort", onClientAbort);
      return errorResponse(c, publicError(first.error, workspaceId));
    }
    open();
    void completion
      .then((output) => {
        model = output.model;
        send(chunk({}, output.result.finishReason));
        if (parsed.includeUsage) {
          send({
            id: chatCompletionId(requestId),
            object: "chat.completion.chunk",
            created,
            model: output.model,
            choices: [],
            usage: chatCompletionUsage(output.result.usage),
          });
        }
        send("[DONE]");
      })
      .catch((error: unknown) => {
        // Headers are already sent; report the failure in-band like OpenAI.
        const failure = publicError(error, workspaceId);
        if (failure) send(chatCompletionError(failure));
      })
      .finally(() => {
        clientSignal.removeEventListener("abort", onClientAbort);
        close();
      });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  });
}

function unavailable(): ModelCallError {
  return new ModelCallError({
    status: 503,
    type: "service_unavailable",
    code: "unavailable",
    message: "Model calls are unavailable on this deployment.",
  });
}

function errorResponse(c: Context, error: ModelCallError | null): Response {
  if (!error) return c.body(null, 499 as never);
  return c.json(chatCompletionError(error), error.status as never);
}
