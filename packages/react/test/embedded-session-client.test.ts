import { describe, expect, test } from "bun:test";
import type {
  ComposerDraft,
  SessionEvent,
  SubmitComposerDraftRequest,
  SubmitComposerDraftResponse,
} from "@opengeni/sdk";

import { createEmbeddedSessionClient } from "../src/embedded-session-client";
import type { EmbeddedSessionClientLike } from "../src/client";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";

const draft = (revision: number, text = ""): ComposerDraft => ({
  revision,
  text,
  annotations: [],
  resources: [],
  model: "model-x",
  reasoningEffort: "medium",
  latencyMode: "standard",
  sourceTurnId: null,
  sourceTurnVersion: null,
  updatedAt: "2026-08-27T00:00:00.000Z",
});

const request = (clientEventId: string, text: string): SubmitComposerDraftRequest => ({
  clientEventId,
  expectedDraftRevision: 1,
  delivery: "send",
  text,
  annotations: [],
  resources: [],
  model: "model-x",
  reasoningEffort: "medium",
  latencyMode: "standard",
  connectionAuthorities: [],
});

const response = (
  input: SubmitComposerDraftRequest,
  replay: boolean,
): SubmitComposerDraftResponse =>
  ({
    accepted: {
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sequence: 1,
      type: "user.message",
      clientEventId: input.clientEventId,
      payload: { text: input.text },
      occurredAt: "2026-08-27T00:00:00.000Z",
    },
    turn: {
      id: "44444444-4444-4444-8444-444444444444",
    },
    draft: draft(2),
    receipt: {
      id: "55555555-5555-4555-8555-555555555555",
      operationKey: input.clientEventId,
    },
    routing: "accepted_for_execution",
    interruptionCount: 0,
    replay,
  }) as SubmitComposerDraftResponse;

describe("createEmbeddedSessionClient", () => {
  test("binds delegated SDK methods to their original receiver", async () => {
    const events: SessionEvent[] = [];
    const base = fakeClient({
      listEvents: async function () {
        return (this as unknown as { retainedEvents: SessionEvent[] }).retainedEvents as never;
      },
    });
    (base as unknown as { retainedEvents: SessionEvent[] }).retainedEvents = events;

    const client = createEmbeddedSessionClient(base);

    expect(await client.listEvents(WORKSPACE_ID, SESSION_ID)).toBe(events);
  });

  test("uses the host atomic-submit override and returns its native response unchanged", async () => {
    const originalRequest = request("66666666-6666-4666-8666-666666666666", "ship it");
    const nativeResponse = response(originalRequest, false);
    const calls: SubmitComposerDraftRequest[] = [];
    const overrides: Partial<EmbeddedSessionClientLike> & { calls: SubmitComposerDraftRequest[] } =
      {
        calls,
        submitComposerDraft: async function (_workspaceId, _sessionId, input) {
          this.calls.push(input);
          return nativeResponse;
        },
      };
    const client = createEmbeddedSessionClient(fakeClient({}), { overrides });

    const actual = await client.submitComposerDraft(WORKSPACE_ID, SESSION_ID, originalRequest);

    expect(actual).toBe(nativeResponse);
    expect(calls).toEqual([originalRequest]);
  });

  test("fails at construction when a required narrow method is absent", () => {
    expect(() => createEmbeddedSessionClient({} as EmbeddedSessionClientLike)).toThrow(
      "Embedded session client method is required: getSession",
    );
  });

  test("maps drafts consistently across read, save, and submit", async () => {
    const base = fakeClient({
      getComposerDraft: async () => draft(1, "read"),
      saveComposerDraft: async () => draft(2, "save"),
      submitComposerDraft: async (_workspaceId, _sessionId, input) => ({
        ...response(input, false),
        draft: draft(3, "submit"),
      }),
    });
    const operations: string[] = [];
    const client = createEmbeddedSessionClient(base, {
      mapComposerDraft: (value, context) => {
        operations.push(context.operation);
        return { ...value, text: `mapped:${value.text}` };
      },
    });
    const input = request("77777777-7777-4777-8777-777777777777", "draft");

    expect((await client.getComposerDraft(WORKSPACE_ID, SESSION_ID)).text).toBe("mapped:read");
    expect(
      (
        await client.saveComposerDraft(WORKSPACE_ID, SESSION_ID, {
          expectedRevision: 1,
          text: "save",
          annotations: [],
          resources: [],
          model: "model-x",
          reasoningEffort: "medium",
          latencyMode: "standard",
        })
      ).text,
    ).toBe("mapped:save");
    expect((await client.submitComposerDraft(WORKSPACE_ID, SESSION_ID, input)).draft.text).toBe(
      "mapped:submit",
    );
    expect(operations).toEqual(["read", "save", "submit"]);
  });

  test("preserves replay, conflict, and unknown-outcome retry semantics", async () => {
    const accepted = new Map<string, { text: string; response: SubmitComposerDraftResponse }>();
    const unknownOnce = new Set<string>();
    const client = createEmbeddedSessionClient(fakeClient({}), {
      overrides: {
        submitComposerDraft: async (_workspaceId, _sessionId, input) => {
          const existing = accepted.get(input.clientEventId);
          if (existing) {
            if (existing.text !== input.text) throw new Error("idempotency conflict");
            return { ...existing.response, replay: true };
          }
          const committed = response(input, false);
          accepted.set(input.clientEventId, { text: input.text, response: committed });
          if (input.text === "unknown" && !unknownOnce.has(input.clientEventId)) {
            unknownOnce.add(input.clientEventId);
            throw new Error("outcome unknown");
          }
          return committed;
        },
      },
    });
    const success = request("88888888-8888-4888-8888-888888888888", "success");
    const unknown = request("99999999-9999-4999-8999-999999999999", "unknown");

    expect((await client.submitComposerDraft(WORKSPACE_ID, SESSION_ID, success)).replay).toBe(
      false,
    );
    expect((await client.submitComposerDraft(WORKSPACE_ID, SESSION_ID, success)).replay).toBe(true);
    await expect(
      client.submitComposerDraft(WORKSPACE_ID, SESSION_ID, { ...success, text: "changed" }),
    ).rejects.toThrow("idempotency conflict");
    await expect(client.submitComposerDraft(WORKSPACE_ID, SESSION_ID, unknown)).rejects.toThrow(
      "outcome unknown",
    );
    expect((await client.submitComposerDraft(WORKSPACE_ID, SESSION_ID, unknown)).replay).toBe(true);
  });
});
