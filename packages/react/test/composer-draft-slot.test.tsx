/* ----------------------------------------------------------------------------
   A session has one composer draft slot. A durable send carries its own
   content and names the draft revision it went ahead from; after accepting
   it the server clears the draft only while it is still at that revision or
   holds exactly what was sent. Two messages sent in quick succession (a Send,
   then a Steer or another Send while the first is still in flight) both
   arrive, in order, and leave no stale text behind in the draft. A server
   older than that still requires the saved content; the composer learns it
   from the first refusal and saves first from then on.
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

function draftChanged(message: string): OpenGeniApiError {
  return new OpenGeniApiError(409, JSON.stringify({ code: "DRAFT_CHANGED", message }), {
    mutation: true,
  });
}

/**
 * The server's draft slot: a save names the exact revision it was made
 * against. A submit is never refused over the draft and clears it only while
 * it still holds what was sent (`fenced`: the older server, which refuses a
 * submit that is not exactly the saved draft at its revision).
 */
function draftSlotServer(latencyMs: { save: number; submit: number }, fenced = false) {
  const slot = { revision: 0, text: "" };
  const delivered: string[] = [];
  const refused: string[] = [];
  const saves: string[] = [];
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
        throw draftChanged("Composer draft changed");
      }
      const saved = await base.saveComposerDraft(workspaceId, target, request);
      slot.revision = saved.revision;
      slot.text = request.text;
      saves.push(request.text);
      return saved;
    },
    submitComposerDraft: async (workspaceId, target, request: SubmitComposerDraftRequest) => {
      await sleep(latencyMs.submit);
      const holdsSent =
        request.expectedDraftRevision === slot.revision || request.text === slot.text;
      if (
        fenced &&
        (request.text !== slot.text || request.expectedDraftRevision !== slot.revision)
      ) {
        refused.push(`${request.delivery} ${request.text}: not the saved draft`);
        throw draftChanged("Composer draft changed");
      }
      const result = await base.submitComposerDraft(workspaceId, target, request);
      if (holdsSent) {
        slot.revision += 1;
        slot.text = "";
      }
      delivered.push(`${request.delivery} ${request.text}`);
      return { ...result, draft: { ...result.draft, revision: slot.revision, text: slot.text } };
    },
  });
  return { client, delivered, refused, saves, slot };
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

/** Wait until the sends are delivered (or give up after ten seconds). */
async function settled(server: { delivered: string[] }, count = 2): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (server.delivered.length < count && Date.now() < deadline) {
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

/** What the server must end with, whichever server it is. */
function expectCleanFinish(server: ReturnType<typeof draftSlotServer>, fenced: boolean): void {
  // A current server never refuses; an older one refuses only the first
  // send, which then saves and goes through.
  expect(server.refused.length).toBeLessThanOrEqual(fenced ? 1 : 0);
  // Nothing sent is left behind as the draft.
  expect(server.slot.text).toBe("");
}

for (const fenced of [false, true]) {
  describe(`one draft slot, two quick messages${fenced ? " (older server)" : ""}`, () => {
    for (const latencyMs of LATENCIES) {
      const timing = `save ${latencyMs.save} ms, submit ${latencyMs.submit} ms`;

      test(`Send then Steer within a second delivers both in order (${timing})`, async () => {
        const server = draftSlotServer(latencyMs, fenced);
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
          expect(server.delivered).toEqual(["send first", "steer second"]);
          expectCleanFinish(server, fenced);
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
        const server = draftSlotServer(latencyMs, fenced);
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
          expect(server.delivered).toEqual(["send first", "send second"]);
          expectCleanFinish(server, fenced);
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

    test("a send waits only for this page's own save already under way, then sends no save of its own", async () => {
      const server = draftSlotServer({ save: 300, submit: 40 }, fenced);
      const hook = await renderHook(
        () => useComposer(sessionId, { client: server.client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      try {
        await flush(10);
        await actRun(() => hook.result.current.setValue("partial"));
        // The autosave of "partial" is now on the wire.
        await flush(550);
        await actRun(() => hook.result.current.setValue("partial and the rest"));
        const sending = await start(() => hook.result.current.steer());
        // The box empties the moment the message is sent.
        expect(hook.result.current.value).toBe("");
        await settled(server, 1);
        expect(await actRun(() => sending.result)).toBe(true);
        expect(server.delivered).toEqual(["steer partial and the rest"]);
        // Named the revision the running save made, so the server cleared
        // that save's text instead of keeping it as a newer draft.
        expectCleanFinish(server, fenced);
        expect(server.saves).toEqual(fenced ? ["partial", "partial and the rest"] : ["partial"]);
        expect(hook.result.current.value).toBe("");
      } finally {
        await hook.unmount();
      }
    });
  });
}
