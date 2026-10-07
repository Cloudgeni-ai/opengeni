import { describe, expect, test } from "bun:test";
import {
  drainPhysicalSandboxResumes,
  trackPhysicalSandboxResume,
  waitForTurnOperation,
} from "../src/activities/agent-turn/sandbox-provision";

describe("physical sandbox establish drain", () => {
  test("joins the physical establish after its cancellable wrapper already rejected", async () => {
    const inFlight = new Set<Promise<unknown>>();
    const cancellation = new AbortController();
    let finishCleanup: (() => void) | undefined;
    const cleanupCommitted: string[] = [];
    // A spawner whose provider call has no abort: after cancellation it still
    // runs its own exact cleanup before settling.
    const physical = trackPhysicalSandboxResume(
      inFlight,
      new Promise<never>((_resolve, reject) => {
        finishCleanup = () => {
          cleanupCommitted.push("warming rolled back to cold");
          reject(new Error("WORKER_SHUTDOWN"));
        };
      }),
    );
    const wrapper = waitForTurnOperation(physical, cancellation.signal, undefined);
    cancellation.abort(new Error("WORKER_SHUTDOWN"));
    await expect(wrapper).rejects.toThrow();
    // The wrapper settled immediately; the physical establish has not.
    expect(inFlight.size).toBe(1);

    const drained = drainPhysicalSandboxResumes(inFlight, 5_000);
    await Bun.sleep(10);
    expect(cleanupCommitted).toEqual([]);
    finishCleanup?.();
    expect(await drained).toBe("settled");
    expect(cleanupCommitted).toEqual(["warming rolled back to cold"]);
    expect(inFlight.size).toBe(0);
  });

  test("is bounded when a provider call never settles", async () => {
    const inFlight = new Set<Promise<unknown>>();
    trackPhysicalSandboxResume(inFlight, new Promise<never>(() => undefined));
    const startedAt = performance.now();
    expect(await drainPhysicalSandboxResumes(inFlight, 20)).toBe("timed_out");
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test("returns immediately when nothing is in flight", async () => {
    const inFlight = new Set<Promise<unknown>>();
    const settled = trackPhysicalSandboxResume(inFlight, Promise.resolve("box"));
    expect(await settled).toBe("box");
    await Bun.sleep(0);
    expect(inFlight.size).toBe(0);
    expect(await drainPhysicalSandboxResumes(inFlight)).toBe("none");
  });
});
