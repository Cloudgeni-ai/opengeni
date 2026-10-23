/* ----------------------------------------------------------------------------
   The composer while Opengeni is updating (the API answers with the parked
   maintenance marker) or briefly unreachable: a message sent meanwhile stays
   in place with its idempotency key and is delivered once the API answers,
   nothing reports a delivery failure, and the composer recovers on its own.
   A failure that outlasts a normal update still fails as before.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { OpenGeniApiError, type SessionEvent } from "@opengeni/sdk";

import { useComposer } from "../src/hooks/use-composer";
import {
  isActionFailure,
  isTransientServiceFailure,
  SERVICE_UPDATING_CALM_WINDOW_MS,
} from "../src/lib/transient-retry";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom({ clock: "virtual" });

const PARKED = JSON.stringify({ error: "maintenance" });
const parkedMutation = () => new OpenGeniApiError(503, PARKED, { mutation: true });
const parkedRead = () => new OpenGeniApiError(503, PARKED, { mutation: false });

function accepted(
  clientEventId: string | undefined,
  text: string,
  sessionId = SESSION_ID,
): SessionEvent {
  return {
    id: crypto.randomUUID(),
    sessionId,
    workspaceId: WORKSPACE_ID,
    sequence: 1,
    type: "user.message",
    payload: { text },
    clientEventId,
    createdAt: new Date().toISOString(),
  } as unknown as SessionEvent;
}

describe("composer while Opengeni is updating", () => {
  test("a message sent during an update is held and delivered once, with the same key", async () => {
    let parked = true;
    const sent: Array<string | undefined> = [];
    const deliveryErrors: Error[] = [];
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, request) => {
        const input = typeof request === "string" ? { text: request } : request;
        sent.push(input.clientEventId);
        if (parked) throw parkedMutation();
        return accepted(input.clientEventId, input.text) as never;
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          onDeliveryError: (error) => void deliveryErrors.push(error),
        }),
      undefined,
    );
    try {
      await flush();
      await actRun(() => hook.result.current.setValue("Ship it"));
      await actRun(() => hook.result.current.send());
      await flush(10);
      expect(sent).toHaveLength(1);

      // A ten-minute park: the message stays "sending", nothing fails.
      await flush(10 * 60_000);
      const held = hook.result.current;
      expect(sent.length).toBeGreaterThan(10);
      expect(new Set(sent).size).toBe(1);
      expect(held.optimisticMessages).toHaveLength(1);
      expect(held.optimisticMessages![0]).toMatchObject({ text: "Ship it", state: "sending" });
      expect(held.optimisticMessages![0]!.error).toBeUndefined();
      expect(held.reconnecting).toBe(true);
      expect(held.error).toBeNull();
      expect(deliveryErrors).toEqual([]);

      // The update finishes: delivered by itself, exactly once more.
      const attempts = sent.length;
      parked = false;
      await flush(10_000);
      expect(sent).toHaveLength(attempts + 1);
      expect(new Set(sent).size).toBe(1);
      expect(hook.result.current.optimisticMessages).toEqual([]);
      expect(hook.result.current.reconnecting).toBe(false);
      expect(hook.result.current.error).toBeNull();
      expect(deliveryErrors).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

  test("an unconfirmed attempt is reconciled before any retry, so it is never sent twice", async () => {
    let reads = 0;
    let acceptedId: string | undefined;
    const sent: Array<string | undefined> = [];
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, request) => {
        const input = typeof request === "string" ? { text: request } : request;
        sent.push(input.clientEventId);
        // The gateway lost the response: the API may have accepted it.
        acceptedId = input.clientEventId;
        throw new OpenGeniApiError(502, "", { mutation: true });
      },
      listEvents: async () => {
        reads += 1;
        // The first reconciliation read still hits the deploy.
        if (reads === 1) throw parkedRead();
        return acceptedId ? [accepted(acceptedId, "Ship it")] : [];
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await flush();
      await actRun(() => hook.result.current.setValue("Ship it"));
      await actRun(() => hook.result.current.send());
      await flush(10);
      expect(hook.result.current.optimisticMessages![0]).toMatchObject({ state: "sending" });
      expect(hook.result.current.reconnecting).toBe(true);
      await flush(30_000);
      expect(sent).toHaveLength(1);
      expect(reads).toBeGreaterThanOrEqual(2);
      // Found on the timeline: admitted, not resent, waiting for its turn.
      expect(hook.result.current.optimisticMessages![0]).toMatchObject({
        state: "queued",
        outcomeUnknown: false,
        error: undefined,
      });
      expect(hook.result.current.reconnecting).toBe(false);
    } finally {
      await hook.unmount();
    }
  });

  test("a failure that outlasts a normal update fails the message as before", async () => {
    const deliveryErrors: Error[] = [];
    const client = fakeClient({
      sendMessage: async () => {
        throw new OpenGeniApiError(503, "", { mutation: false, correlationId: "edge-1" });
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          onDeliveryError: (error) => void deliveryErrors.push(error),
        }),
      undefined,
    );
    try {
      await flush();
      await actRun(() => hook.result.current.setValue("Ship it"));
      await actRun(() => hook.result.current.send());
      await flush(SERVICE_UPDATING_CALM_WINDOW_MS / 2);
      expect(hook.result.current.optimisticMessages![0]).toMatchObject({ state: "sending" });
      expect(deliveryErrors).toEqual([]);

      await flush(SERVICE_UPDATING_CALM_WINDOW_MS);
      const failed = hook.result.current.optimisticMessages![0]!;
      expect(failed.state).toBe("failed");
      expect(failed.retryable).toBe(true);
      expect(failed.error).toBeDefined();
      expect(hook.result.current.reconnecting).toBe(false);
      expect(deliveryErrors).toHaveLength(1);
    } finally {
      await hook.unmount();
    }
  });

  test("a definitive refusal fails at once", async () => {
    const client = fakeClient({
      sendMessage: async () => {
        throw new OpenGeniApiError(
          400,
          JSON.stringify({ error: { code: "invalid_request", message: "Bad request" } }),
          { mutation: true },
        );
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await flush();
      await actRun(() => hook.result.current.setValue("Ship it"));
      await actRun(() => hook.result.current.send());
      await flush(10);
      expect(hook.result.current.optimisticMessages![0]).toMatchObject({ state: "failed" });
      expect(hook.result.current.reconnecting).toBe(false);
    } finally {
      await hook.unmount();
    }
  });

  test("a draft save blocked by an update clears by itself once the API answers", async () => {
    let parked = false;
    const saves: string[] = [];
    const base = fakeClient({});
    const client = fakeClient({
      getComposerDraft: async (...args) => {
        if (parked) throw parkedRead();
        return await base.getComposerDraft(...args);
      },
      saveComposerDraft: async (workspaceId, sessionId, request) => {
        saves.push(request.text);
        if (parked) throw parkedMutation();
        return await base.saveComposerDraft(workspaceId, sessionId, request);
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await flush(10);
      parked = true;
      await actRun(() => hook.result.current.setValue("Draft during the update"));
      await flush(1_000);
      expect(hook.result.current.error).toBeInstanceOf(OpenGeniApiError);
      await flush(60_000);
      expect(hook.result.current.error).not.toBeNull();

      parked = false;
      await flush(10_000);
      expect(hook.result.current.error).toBeNull();
      expect(saves.at(-1)).toBe("Draft during the update");
      expect(hook.result.current.draft?.text).toBe("Draft during the update");
    } finally {
      await hook.unmount();
    }
  });

  test("a held send the event stream confirms clears the updating state", async () => {
    // Its own session: pending messages are remembered per session.
    const sessionId = crypto.randomUUID();
    const sent: Array<string | undefined> = [];
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, request) => {
        const input = typeof request === "string" ? { text: request } : request;
        sent.push(input.clientEventId);
        // The gateway drops the response; the message was in fact accepted.
        throw new OpenGeniApiError(502, "", { mutation: true });
      },
    });
    type Props = { events: SessionEvent[] };
    const hook = await renderHook(
      (props: Props) =>
        useComposer(sessionId, {
          client,
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: { model: "model-x", reasoningEffort: "medium", latencyMode: "standard" },
          events: props.events,
        }),
      { events: [] as SessionEvent[] },
    );
    try {
      await flush();
      await actRun(() => hook.result.current.setValue("Ship it"));
      await actRun(() => hook.result.current.send());
      await flush(10);
      expect(hook.result.current.reconnecting).toBe(true);
      expect(sent).toHaveLength(1);

      // The reconnected stream delivers the accepted message before any retry.
      await hook.rerender({ events: [accepted(sent[0], "Ship it", sessionId)] });
      await flush(10);
      expect(hook.result.current.optimisticMessages![0]).toMatchObject({
        state: "queued",
        outcomeUnknown: false,
      });
      expect(hook.result.current.reconnecting).toBe(false);
      await flush(60_000);
      expect(hook.result.current.reconnecting).toBe(false);
      expect(sent).toHaveLength(1);
    } finally {
      await hook.unmount();
    }
  });

  test("a Stop that fails during an update stays visible until the person acts", async () => {
    // Its own session: pending messages are remembered per session.
    const sessionId = crypto.randomUUID();
    const client = fakeClient({
      pauseSession: async () => {
        throw parkedMutation();
      },
    });
    const hook = await renderHook(
      () => useComposer(sessionId, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      // The draft has loaded (adopting it starts from a clean composer).
      await flush(1_000);
      await actRun(() => hook.result.current.pause());
      await flush(10);
      const failure = hook.result.current.error;

      expect(failure).toBeInstanceOf(OpenGeniApiError);
      expect(isActionFailure(failure)).toBe(true);
      // Opengeni answers again (the draft probe would succeed): the failed Stop
      // is not cleared behind the person's back.
      await flush(60_000);
      expect(hook.result.current.error).toBe(failure);
      await actRun(() => hook.result.current.clearError());
      expect(hook.result.current.error).toBeNull();
    } finally {
      await hook.unmount();
    }
  });

  test("a 503 the API marks not retryable fails at once instead of waiting", async () => {
    // Its own session: pending messages are remembered per session.
    const sessionId = crypto.randomUUID();
    const definitive = new OpenGeniApiError(
      503,
      JSON.stringify({
        error: { code: "workspace_unavailable", message: "Not available", retryable: false },
      }),
      { mutation: true },
    );
    expect(definitive.retryable).toBe(false);
    expect(isTransientServiceFailure(definitive)).toBe(false);
    const sent: string[] = [];
    const client = fakeClient({
      sendMessage: async () => {
        sent.push("send");
        throw definitive;
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(sessionId, {
          client,
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: { model: "model-x", reasoningEffort: "medium", latencyMode: "standard" },
        }),
      undefined,
    );
    try {
      await flush();
      await actRun(() => hook.result.current.setValue("Ship it"));
      await actRun(() => hook.result.current.send());
      await flush(30_000);
      expect(sent).toHaveLength(1);
      expect(hook.result.current.optimisticMessages![0]).toMatchObject({ state: "failed" });
      expect(hook.result.current.reconnecting).toBe(false);
    } finally {
      await hook.unmount();
    }
  });

  test("a send blocked by a draft save during an update is held as not yet submitted", async () => {
    // Its own session: pending messages are remembered per session.
    const sessionId = crypto.randomUUID();
    let parked = true;
    const submits: string[] = [];
    const base = fakeClient({});
    const client = fakeClient({
      saveComposerDraft: async (workspaceId, target, request) => {
        // A bodiless gateway answer, which the SDK reports as outcome-unknown.
        if (parked) throw new OpenGeniApiError(503, "", { mutation: true });
        return await base.saveComposerDraft(workspaceId, target, request);
      },
      submitComposerDraft: async (workspaceId, target, request) => {
        submits.push(request.clientEventId ?? "");
        return await base.submitComposerDraft(workspaceId, target, request);
      },
    });
    const hook = await renderHook(
      () => useComposer(sessionId, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await flush(10);
      await actRun(() => hook.result.current.setValue("Ship it"));
      await actRun(() => hook.result.current.send());
      await flush(10);
      expect(submits).toEqual([]);
      expect(hook.result.current.reconnecting).toBe(true);
      expect(hook.result.current.optimisticMessages![0]).toMatchObject({
        state: "sending",
        outcomeUnknown: false,
      });
      parked = false;
      await flush(10_000);
      expect(submits).toHaveLength(1);
      expect(hook.result.current.reconnecting).toBe(false);
    } finally {
      await hook.unmount();
    }
  });
});
