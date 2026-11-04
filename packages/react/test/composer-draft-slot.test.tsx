/* ----------------------------------------------------------------------------
   A session has one composer draft slot, and a durable send submits exactly
   the content saved there at an exact revision. Two messages sent in quick
   succession (a Send, then a Steer or another Send while the first is still
   in flight) must not write the slot between the other's save and submit:
   both arrive, in order, and neither is refused as "not the saved draft".
   -------------------------------------------------------------------------- */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  OpenGeniApiError,
  type SessionEvent,
  type SteerMessageResult,
  type SubmitComposerDraftRequest,
} from "@opengeni/sdk";

import { useComposer } from "../src/hooks/use-composer";
import { fakeClient, fakeTurn, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

// Real time: a Steer holds `act` open on the virtual clock. Every wait below
// is for an outcome, never for a fixed duration, so timing cannot decide a
// result; the server latencies only vary how the two sends overlap.
registerDom({ clock: "real" });

let sessionId = crypto.randomUUID();
beforeEach(() => {
  sessionId = crypto.randomUUID();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function conflict(message: string): OpenGeniApiError {
  return new OpenGeniApiError(409, JSON.stringify({ code: "conflict", message }), {
    mutation: true,
  });
}

/**
 * The server's draft fence: one slot; a save and a submit each name the exact
 * revision they were made against, and a submit must carry the saved content.
 */
function draftSlotServer(latencyMs: { save: number; submit: number }) {
  const slot = { revision: 0, text: "" };
  const delivered: string[] = [];
  const refused: string[] = [];
  let sequence = 0;
  const accepted = (text: string, clientEventId: string | undefined): SessionEvent =>
    ({
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE_ID,
      sessionId,
      sequence: ++sequence,
      type: "user.message",
      payload: { text },
      clientEventId: clientEventId ?? null,
      occurredAt: new Date().toISOString(),
    }) as SessionEvent;
  const base = fakeClient({
    sendMessage: async (_workspaceId, _sessionId, input) => {
      const request = typeof input === "string" ? { text: input } : input;
      return accepted(request.text, request.clientEventId);
    },
    steerMessage: async (_workspaceId, _sessionId, input) => {
      const request = typeof input === "string" ? { text: input } : input;
      const turn = fakeTurn();
      return {
        accepted: accepted(request.text, request.clientEventId),
        turn,
        receipt: {
          id: crypto.randomUUID(),
          action: "prompt.steer",
          operationKey: crypto.randomUUID(),
          targetSessionId: sessionId,
          targetTurnId: turn.id,
          appliedControlRevision: null,
          appliedQueueVersion: null,
          appliedTurnVersion: null,
          appliedDraftRevision: null,
          createdAt: new Date().toISOString(),
        },
        routing: "accepted_for_steering",
        interruptionCount: 0,
        replay: false,
      } satisfies SteerMessageResult;
    },
  });
  const client = fakeClient({
    sendMessage: base.sendMessage,
    steerMessage: base.steerMessage,
    getComposerDraft: async (workspaceId, target) => ({
      ...(await base.getComposerDraft(workspaceId, target)),
      revision: slot.revision,
      text: slot.text,
    }),
    saveComposerDraft: async (workspaceId, target, request) => {
      await sleep(latencyMs.save);
      if (request.expectedRevision !== slot.revision) {
        refused.push(`save ${request.text}: draft changed`);
        throw conflict("Composer draft changed");
      }
      const saved = await base.saveComposerDraft(workspaceId, target, request);
      slot.revision = saved.revision;
      slot.text = request.text;
      return saved;
    },
    submitComposerDraft: async (workspaceId, target, request: SubmitComposerDraftRequest) => {
      await sleep(latencyMs.submit);
      if (request.text !== slot.text) {
        refused.push(`${request.delivery} ${request.text}: not the saved draft`);
        throw conflict("Submitted content is not the saved draft");
      }
      if (request.expectedDraftRevision !== slot.revision) {
        refused.push(`${request.delivery} ${request.text}: draft changed`);
        throw conflict("Composer draft changed");
      }
      const result = await base.submitComposerDraft(workspaceId, target, request);
      slot.revision = result.draft.revision;
      slot.text = "";
      delivered.push(`${request.delivery} ${request.text}`);
      return result;
    },
  });
  return { client, delivered, refused };
}

/**
 * Start an action without waiting for it to finish. The promise is boxed:
 * an async function that returns a promise waits for it, which would run the
 * two sends one after the other (and outside `act`) instead of overlapping.
 */
async function start(run: () => Promise<boolean>): Promise<{ result: Promise<boolean> }> {
  let result!: Promise<boolean>;
  await actRun(() => {
    result = run();
  });
  return { result };
}

/** Wait until both sends are settled by the server, whichever way. */
async function settled(server: { delivered: string[]; refused: string[] }): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (server.delivered.length + server.refused.length < 2 && Date.now() < deadline) {
    await flush(10);
  }
  // Let the client finish handling the last response.
  await flush(50);
}

const LATENCIES = [
  { save: 40, submit: 40 },
  { save: 5, submit: 120 },
  { save: 120, submit: 5 },
  { save: 40, submit: 900 },
];

describe("one draft slot, two quick messages", () => {
  for (const latencyMs of LATENCIES) {
    const timing = `save ${latencyMs.save} ms, submit ${latencyMs.submit} ms`;

    test(`Send then Steer within a second delivers both in order (${timing})`, async () => {
      const server = draftSlotServer(latencyMs);
      const hook = await renderHook(
        () => useComposer(sessionId, { client: server.client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      try {
        await flush(10);
        await actRun(() => hook.result.current.setValue("first"));
        const sending = await start(() => hook.result.current.send());
        await flush(15);
        await actRun(() => hook.result.current.setValue("second"));
        const steering = await start(() => hook.result.current.steer());
        await settled(server);
        expect(await actRun(() => sending.result)).toBe(true);
        expect(await actRun(() => steering.result)).toBe(true);
        expect(server.refused).toEqual([]);
        expect(server.delivered).toEqual(["send first", "steer second"]);
        expect(hook.result.current.error).toBeNull();
        expect(
          (hook.result.current.optimisticMessages ?? []).filter(
            (message) => message.state === "failed",
          ),
        ).toEqual([]);
      } finally {
        await hook.unmount();
      }
    });

    test(`two quick Sends deliver both in order (${timing})`, async () => {
      const server = draftSlotServer(latencyMs);
      const hook = await renderHook(
        () => useComposer(sessionId, { client: server.client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      try {
        await flush(10);
        await actRun(() => hook.result.current.setValue("first"));
        await start(() => hook.result.current.send());
        await flush(15);
        await actRun(() => hook.result.current.setValue("second"));
        // Long enough for the draft autosave of "second" to fire mid-flight.
        await flush(600);
        await start(() => hook.result.current.send());
        await settled(server);
        expect(server.refused).toEqual([]);
        expect(server.delivered).toEqual(["send first", "send second"]);
        expect(hook.result.current.error).toBeNull();
        expect(
          (hook.result.current.optimisticMessages ?? []).filter(
            (message) => message.state === "failed",
          ),
        ).toEqual([]);
      } finally {
        await hook.unmount();
      }
    });
  }
});
