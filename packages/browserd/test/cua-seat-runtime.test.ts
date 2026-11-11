import { describe, expect, test } from "bun:test";
import { openSeatRuntime } from "../src/cua/factory";

function fakeWorker(options: { answers?: () => boolean; callMs?: number } = {}) {
  const state = { running: 0, maxRunning: 0, calls: [] as string[], stopped: false };
  const sdk = {
    listToolsJson: async () => "[]",
    callTool: async (name: string) => {
      state.running += 1;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      state.calls.push(name);
      await Bun.sleep(options.callMs ?? 5);
      state.running -= 1;
      return { text: name, isError: false } as never;
    },
    shutdown: async () => {
      state.stopped = true;
    },
    metadata: async () => {
      if (options.answers && !options.answers()) throw new Error("worker exited");
      return { pid: 1 };
    },
  };
  return { sdk, state };
}

describe("CUA physical seat runtime", () => {
  test("sessions on one desktop share one worker and run its calls one at a time", async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const create = async () => {
      const worker = fakeWorker();
      workers.push(worker);
      return worker.sdk;
    };
    const first = await openSeatRuntime(create);
    const second = await openSeatRuntime(create);
    expect(workers).toHaveLength(1);

    await Promise.all([
      first.callTool("a", "{}"),
      second.callTool("b", "{}"),
      first.callTool("c", "{}"),
    ]);
    expect(workers[0]!.state.maxRunning).toBe(1);
    expect(workers[0]!.state.calls).toEqual(["a", "b", "c"]);

    // One session ending leaves the worker to the other.
    await first.shutdown();
    await first.shutdown();
    expect(workers[0]!.state.stopped).toBe(false);
    await second.callTool("d", "{}");

    // The last session stops it; the next session starts a fresh one.
    await second.shutdown();
    expect(workers[0]!.state.stopped).toBe(true);
    const third = await openSeatRuntime(create);
    expect(workers).toHaveLength(2);
    await third.shutdown();
    expect(workers[1]!.state.stopped).toBe(true);
  });

  test("a failed call does not stop the calls queued behind it", async () => {
    let fail = true;
    const worker = fakeWorker();
    const callTool = worker.sdk.callTool;
    worker.sdk.callTool = async (name: string) => {
      if (fail) {
        fail = false;
        throw new Error("transport failed");
      }
      return await callTool(name);
    };
    const runtime = await openSeatRuntime(async () => worker.sdk);
    const [failed, next] = await Promise.allSettled([
      runtime.callTool("a", "{}"),
      runtime.callTool("b", "{}"),
    ]);
    expect(failed.status).toBe("rejected");
    expect(next.status).toBe("fulfilled");
    await runtime.shutdown();
  });

  test("a worker that stopped answering is replaced for the next session", async () => {
    let alive = true;
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const create = async () => {
      const worker = fakeWorker({ answers: () => workers.indexOf(worker) > 0 || alive });
      workers.push(worker);
      return worker.sdk;
    };
    const first = await openSeatRuntime(create);
    alive = false;
    const second = await openSeatRuntime(create);
    expect(workers).toHaveLength(2);
    // The old worker stops once its last session leaves.
    expect(workers[0]!.state.stopped).toBe(false);
    await first.shutdown();
    expect(workers[0]!.state.stopped).toBe(true);
    expect(workers[1]!.state.stopped).toBe(false);
    await second.shutdown();
    expect(workers[1]!.state.stopped).toBe(true);
  });
});
