import { expect, test } from "bun:test";
import { signalBackgroundCommandWakes, type SessionWorkflowWake } from "../src/index";

// Settlement callers signal committed wakes as a best-effort hint after commit:
// a slow, failing or throwing signaler must never hold up or fail the caller,
// and the periodic dispatcher still delivers any wake left undelivered.

const wake = (sessionId: string, wakeRevision: number): SessionWorkflowWake => ({
  accountId: "account",
  workspaceId: "workspace",
  sessionId,
  temporalWorkflowId: `session-${sessionId}`,
  wakeRevision,
  interruptionRequested: false,
});

test("one signal per session, at its newest revision, all at once", async () => {
  const sent: SessionWorkflowWake[] = [];
  let inFlight = 0;
  let peak = 0;
  await signalBackgroundCommandWakes(
    [wake("a", 3), wake("b", 1), wake("a", 4)],
    async (pending) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(10);
      inFlight -= 1;
      sent.push(pending);
    },
  );
  expect(sent.map((pending) => `${pending.sessionId}@${pending.wakeRevision}`).sort()).toEqual([
    "a@4",
    "b@1",
  ]);
  expect(peak).toBe(2);
});

test("a hung signal is abandoned at the bound and failures are reported, not thrown", async () => {
  const errors: string[] = [];
  const started = Date.now();
  await signalBackgroundCommandWakes(
    [wake("hung", 1), wake("rejects", 1), wake("throws", 1)],
    (pending) => {
      if (pending.sessionId === "throws") throw new Error("synchronous");
      if (pending.sessionId === "rejects") return Promise.reject(new Error("Temporal unavailable"));
      return new Promise(() => undefined);
    },
    {
      timeoutMs: 100,
      onError: (error, pending) => errors.push(`${pending.sessionId}: ${(error as Error).message}`),
    },
  );
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(errors.sort()).toEqual([
    "hung: wake signal still pending after 100 ms",
    "rejects: Temporal unavailable",
    "throws: synchronous",
  ]);
});

test("no signaler or no wakes is a no-op", async () => {
  await signalBackgroundCommandWakes([wake("a", 1)], undefined);
  await signalBackgroundCommandWakes(undefined, async () => {
    throw new Error("must not be called");
  });
  await signalBackgroundCommandWakes([], async () => {
    throw new Error("must not be called");
  });
});
