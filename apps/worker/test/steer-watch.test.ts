import { afterEach, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import type { SessionEvent } from "@opengeni/contracts";
import { ModelPreemption } from "@opengeni/runtime";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { startSteerWatch, type SteerWatch } from "../src/activities/agent-turn/steer-watch";

const ids = {
  accountId: "account-steer-watch",
  workspaceId: "workspace-steer-watch",
  sessionId: "session-steer-watch",
  turnId: "turn-steer-watch",
};
const steerRequested = [{ type: "session.control.steer_requested" }] as unknown as SessionEvent[];

let watch: SteerWatch | null = null;
let restore: (() => void) | null = null;
afterEach(() => {
  watch?.close();
  watch = null;
  restore?.();
  restore = null;
});

async function until(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await Bun.sleep(5);
  }
}

test("a re-armed watch notices a Steer committed while it was tripped, without waiting for the safety recheck", async () => {
  let pending = false;
  const read = spyOn(opengeniDb, "hasPendingSteerForTurn").mockImplementation(async () => pending);
  restore = () => read.mockRestore();
  const bus = new MemoryEventBus();
  const yields: boolean[] = [];
  watch = await startSteerWatch({
    db: {} as opengeniDb.Database,
    bus,
    ...ids,
    onPending: (value) => yields.push(value),
  });

  // A Steer trips the watch.
  pending = true;
  await bus.publish(ids.workspaceId, ids.sessionId, steerRequested);
  await until(() => watch!.signal().aborted);
  expect(watch.signal().reason).toBeInstanceOf(ModelPreemption);

  // It is withdrawn, and a new Steer lands while the watch is still tripped:
  // its live event finds the watch already aborted and is not acted on.
  pending = false;
  await bus.publish(ids.workspaceId, ids.sessionId, steerRequested);
  pending = true;
  await bus.publish(ids.workspaceId, ids.sessionId, steerRequested);

  // The turn re-arms after it found no Steer at its boundary. The Steer that
  // is waiting now must cut the next request short at once, not after the
  // ten-second safety recheck.
  watch.rearm();
  await until(() => watch!.signal().aborted, 1_000);
  expect(yields).toEqual([true, false, true]);
});

test("re-arming with no Steer waiting keeps the watch listening", async () => {
  let pending = true;
  const read = spyOn(opengeniDb, "hasPendingSteerForTurn").mockImplementation(async () => pending);
  restore = () => read.mockRestore();
  const bus = new MemoryEventBus();
  watch = await startSteerWatch({
    db: {} as opengeniDb.Database,
    bus,
    ...ids,
    onPending: () => {},
  });
  await bus.publish(ids.workspaceId, ids.sessionId, steerRequested);
  await until(() => watch!.signal().aborted);

  pending = false;
  watch.rearm();
  await Bun.sleep(50);
  expect(watch.signal().aborted).toBe(false);
  // The next live Steer event still wakes it.
  pending = true;
  await bus.publish(ids.workspaceId, ids.sessionId, steerRequested);
  await until(() => watch!.signal().aborted);
});
