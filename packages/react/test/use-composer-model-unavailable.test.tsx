import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import { conversationTimeline } from "../src/conversation-timeline";
import { useComposer } from "../src/hooks/use-composer";
import { COMPOSER_MODEL_UNAVAILABLE_MESSAGE } from "../src/lib/format";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

function modelUnavailableResponse(modelId: string): OpenGeniApiError {
  return new OpenGeniApiError(
    422,
    JSON.stringify({
      error: {
        status: 422,
        code: "validation_failed",
        message: `model is not available: ${modelId}`,
        retryable: false,
        requestId: "req-removed-model",
        details: { code: "model_unavailable", modelId },
      },
    }),
    { mutation: true },
  );
}

describe("useComposer with a model removed from the catalog", () => {
  test("refusal shows plain copy, offers Edit instead of Retry, and keeps the typed message", async () => {
    const sessionId = crypto.randomUUID();
    const removedModel = "openrouter/vendor/retired-model:free";
    const sent: (string | undefined)[] = [];
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, message) => {
        const input = typeof message === "string" ? { text: message } : message;
        sent.push(input.model);
        if (input.model === removedModel) throw modelUnavailableResponse(removedModel);
        return {
          id: crypto.randomUUID(),
          sessionId,
          sequence: 2,
          type: "user.message",
          payload: { text: input.text },
          createdAt: new Date().toISOString(),
        } as never;
      },
    });
    const render = () =>
      renderHook(
        () =>
          useComposer(sessionId, {
            client,
            workspaceId: WORKSPACE_ID,
            draftPersistence: "disabled",
            initialPolicy: {
              model: removedModel,
              reasoningEffort: "medium",
              latencyMode: "standard",
            },
          }),
        undefined,
      );
    const hook = await render();
    await actRun(() => hook.result.current.setValue("summarize the last run"));
    await actRun(() => hook.result.current.send());
    await flush();

    const refused = hook.result.current.optimisticMessages![0]!;
    expect(refused).toMatchObject({
      state: "failed",
      text: "summarize the last run",
      retryable: false,
      outcomeUnknown: false,
      error: COMPOSER_MODEL_UNAVAILABLE_MESSAGE,
    });
    expect(refused.error).not.toMatch(/422|Reference|retired-model/);

    // The timeline row offers Edit message and Remove, never Retry.
    const [row] = conversationTimeline(
      [],
      { queue: [], snapshot: null, acceptedSteers: [] },
      hook.result.current,
    );
    expect(row?.kind).toBe("user-message");
    const delivery = row?.kind === "user-message" ? row.delivery : undefined;
    expect(delivery?.error).toBe(COMPOSER_MODEL_UNAVAILABLE_MESSAGE);
    expect(delivery?.onRetry).toBeUndefined();
    expect(typeof delivery?.onEdit).toBe("function");
    expect(typeof delivery?.onRemove).toBe("function");

    // A retry of the same send is refused locally instead of hitting the API again.
    await actRun(() => hook.result.current.retryOptimisticMessage?.(refused.clientEventId));
    await flush();
    expect(sent).toEqual([removedModel]);
    await hook.unmount();

    // The failed message survives a reload with the same copy and no retry.
    const remounted = await render();
    expect(remounted.result.current.optimisticMessages![0]).toMatchObject({
      state: "failed",
      text: "summarize the last run",
      retryable: false,
      error: COMPOSER_MODEL_UNAVAILABLE_MESSAGE,
    });

    // Choosing another model and Edit message puts the text back for sending.
    await actRun(() => remounted.result.current.setModel("gpt-available"));
    await actRun(() => remounted.result.current.restoreOptimisticMessage?.(refused.clientEventId));
    expect(remounted.result.current.value).toBe("summarize the last run");
    expect(remounted.result.current.policy?.model).toBe("gpt-available");
    expect(remounted.result.current.optimisticMessages).toEqual([]);
    await actRun(() => remounted.result.current.send());
    await flush();
    expect(sent).toEqual([removedModel, "gpt-available"]);
    await remounted.unmount();
  });
});
