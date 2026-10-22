import { describe, expect, test } from "bun:test";
import {
  createEagerOwnedSandboxSetup,
  type EagerOwnedSandboxSetupDeps,
  type EagerOwnedSandboxSetupOptions,
} from "../src/activities/agent-turn/owned-sandbox-setup";

function depsFor(sandbox: { leaseEpoch: number; instanceId: string }) {
  const sandboxState = {
    resolvedSandbox: {
      leaseEpoch: sandbox.leaseEpoch,
      established: { instanceId: sandbox.instanceId },
    },
  };
  return {
    deps: { sandboxState } as unknown as EagerOwnedSandboxSetupDeps,
    rebind(next: { leaseEpoch: number; instanceId: string }) {
      sandboxState.resolvedSandbox = {
        leaseEpoch: next.leaseEpoch,
        established: { instanceId: next.instanceId },
      };
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("eager owned sandbox setup", () => {
  test("a prestarted setup runs once, before input preparation finishes, and the first stream joins it", async () => {
    const { deps } = depsFor({ leaseEpoch: 1, instanceId: "box-a" });
    const gate = deferred();
    const calls: EagerOwnedSandboxSetupOptions[] = [];
    const setup = createEagerOwnedSandboxSetup(
      deps,
      { fileDownloadsMaterialized: true },
      async (_deps, options) => {
        calls.push(options);
        await gate.promise;
      },
    );
    // Started immediately, without waiting for the model input.
    expect(calls).toEqual([{ fileDownloadsMaterialized: true }]);
    let joined = false;
    const first = setup.beforeModelStream({ fileDownloadsMaterialized: true }).then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    gate.resolve();
    await first;
    expect(joined).toBe(true);
    expect(calls).toHaveLength(1);
    // Later streams of the attempt (retries, steer resumes) run setup again.
    await setup.beforeModelStream({ fileDownloadsMaterialized: true });
    expect(calls).toHaveLength(2);
    await setup.settled();
  });

  test("an early failure surfaces on the first stream and settles without an unhandled rejection", async () => {
    const { deps } = depsFor({ leaseEpoch: 1, instanceId: "box-a" });
    const failure = new Error("clone failed");
    const setup = createEagerOwnedSandboxSetup(
      deps,
      { fileDownloadsMaterialized: false },
      async () => {
        throw failure;
      },
    );
    await setup.settled();
    await expect(setup.beforeModelStream({ fileDownloadsMaterialized: false })).rejects.toBe(
      failure,
    );
  });

  test("a box rebound while the prestarted setup ran gets its own setup", async () => {
    const { deps, rebind } = depsFor({ leaseEpoch: 1, instanceId: "box-a" });
    const boxes: string[] = [];
    const gate = deferred();
    const setup = createEagerOwnedSandboxSetup(
      deps,
      { fileDownloadsMaterialized: true },
      async (current) => {
        boxes.push(current.sandboxState.resolvedSandbox!.established.instanceId);
        if (boxes.length === 1) await gate.promise;
      },
    );
    rebind({ leaseEpoch: 2, instanceId: "box-b" });
    gate.resolve();
    await setup.beforeModelStream({ fileDownloadsMaterialized: true });
    expect(boxes).toEqual(["box-a", "box-b"]);
  });

  test("without a prestart the first stream runs setup with its prepared input", async () => {
    const { deps } = depsFor({ leaseEpoch: 1, instanceId: "box-a" });
    const calls: EagerOwnedSandboxSetupOptions[] = [];
    const setup = createEagerOwnedSandboxSetup(deps, undefined, async (_deps, options) => {
      calls.push(options);
    });
    expect(calls).toHaveLength(0);
    await setup.settled();
    const preparedInput = {
      input: [],
    } as unknown as EagerOwnedSandboxSetupOptions["preparedInput"];
    await setup.beforeModelStream({ fileDownloadsMaterialized: false, preparedInput });
    expect(calls).toEqual([{ fileDownloadsMaterialized: false, preparedInput }]);
  });
});
