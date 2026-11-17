import { expect, test } from "bun:test";
import { CancelledFailure } from "@temporalio/activity";
import {
  untilWorkerShutdown,
  WORKER_SHUTDOWN_TURN_UNWIND_MS,
} from "../src/activities/agent-turn/worker-shutdown-handoff";
import { WORKER_SHUTDOWN_MIN_CHECKPOINT_WINDOW_MS } from "../src/worker-shutdown";

const never = new Promise<never>(() => undefined);

test("the unwind budget leaves most of the shutdown checkpoint window for settlement", () => {
  expect(WORKER_SHUTDOWN_TURN_UNWIND_MS * 3).toBeLessThanOrEqual(
    WORKER_SHUTDOWN_MIN_CHECKPOINT_WINDOW_MS,
  );
});

test("a run parked past the unwind budget is abandoned with the shutdown cancellation", async () => {
  const shutdown = new AbortController();
  const handedOff = untilWorkerShutdown(shutdown.signal, never, 20);
  const reason = new CancelledFailure("WORKER_SHUTDOWN");
  shutdown.abort(reason);
  expect(await handedOff.catch((error: unknown) => error)).toBe(reason);
});

test("a run that unwinds within the budget keeps its own outcome", async () => {
  const shutdown = new AbortController();
  const unwound = new Error("cooperative unwind");
  const run = new Promise<never>((_resolve, reject) => {
    shutdown.signal.addEventListener("abort", () => setTimeout(() => reject(unwound), 5));
  });
  const handedOff = untilWorkerShutdown(shutdown.signal, run, 1_000);
  shutdown.abort(new CancelledFailure("WORKER_SHUTDOWN"));
  expect(await handedOff.catch((error: unknown) => error)).toBe(unwound);
});

test("other cancellations wait for the run to unwind itself", async () => {
  const cancel = new AbortController();
  let finish!: (value: string) => void;
  const run = new Promise<string>((resolve) => (finish = resolve));
  const awaited = untilWorkerShutdown(cancel.signal, run, 5);
  cancel.abort(new CancelledFailure("CANCELLED"));
  await Bun.sleep(30);
  finish("finished");
  expect(await awaited).toBe("finished");
});

test("a shutdown that came before the run started still bounds it", async () => {
  const shutdown = new AbortController();
  const reason = new CancelledFailure("WORKER_SHUTDOWN");
  shutdown.abort(reason);
  expect(
    await untilWorkerShutdown(shutdown.signal, never, 5).catch((error: unknown) => error),
  ).toBe(reason);
});
