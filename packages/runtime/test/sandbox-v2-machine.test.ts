import { describe, expect, test } from "bun:test";
import { selectSandboxEngine } from "../src/sandbox/v2/engine";
import {
  MachineController,
  newMachine,
  type MachineBackend,
  type MachineDemand,
  type MachineRecord,
  type MachineScope,
  type MachineStore,
  type MachineTransition,
  type TransitionResult,
} from "../src/sandbox/v2/machine-controller";

const scope: MachineScope = { workspaceId: "workspace-test", sandboxGroupId: "group-test" };
const attempt: MachineDemand = {
  id: "attempt-a",
  owner: "session-a",
  kind: "attempt",
  authority: "a-1",
};
const command: MachineDemand = {
  id: "command-b",
  owner: "session-b",
  kind: "command",
  authority: "b-1",
};
class Store implements MachineStore {
  row = newMachine(scope, "synthetic", "machine-test");
  onWrite?: (next: MachineRecord) => Promise<void>;
  async load(_scope: MachineScope) {
    return structuredClone(this.row);
  }
  async compareAndSet(previous: MachineRecord, next: MachineRecord) {
    if (previous.version !== this.row.version) return false;
    expect(next.version).toBe(previous.version + 1);
    this.row = structuredClone(next);
    await this.onWrite?.(structuredClone(next));
    return true;
  }
}
function settled(transition: MachineTransition): TransitionResult {
  const state =
    transition.kind === "create" || transition.kind === "resume"
      ? "running"
      : transition.kind === "suspend"
        ? "suspended"
        : "destroyed";
  return {
    outcome: "settled",
    transitionId: transition.id,
    state,
    instance:
      state === "running"
        ? { id: "instance-test", bootId: "boot-test", diskLineage: "disk-test" }
        : null,
    disk: state === "destroyed" ? null : { providerDisk: "disk-test" },
  };
}
function fixture() {
  const store = new Store();
  const dispatched: MachineTransition[] = [];
  const reconciled: MachineTransition[] = [];
  let clock = 0;
  let nextId = 0;
  const backend: MachineBackend = {
    provider: "synthetic",
    async dispatch(_machine, transition) {
      dispatched.push(transition);
      return settled(transition);
    },
    async reconcile(_machine, transition) {
      reconciled.push(transition);
      return { outcome: "unknown" };
    },
  };
  const controller = new MachineController(
    store,
    backend,
    100,
    () => clock,
    () => `op-${++nextId}`,
  );
  return {
    store,
    controller,
    backend,
    dispatched,
    reconciled,
    time(value: number) {
      clock = value;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("sandbox v2 lifecycle admission", () => {
  test("provider definition is durable before dispatch and survives changed defaults", async () => {
    const f = fixture();
    const defaults = { image: "synthetic-image-a", memory: 256 };
    f.backend.prepareTransition = () => defaults;
    f.store.onWrite = async (next) => {
      if (next.transition?.phase === "reserved") {
        defaults.image = "synthetic-image-b";
        defaults.memory = 512;
      }
    };
    f.backend.dispatch = async (_machine, transition) => {
      f.dispatched.push(transition);
      expect(transition.definition).toEqual({ image: "synthetic-image-a", memory: 256 });
      return { outcome: "unknown" };
    };
    await f.controller.acquire(scope, attempt);
    const unknown = await f.controller.step(scope);
    expect(unknown.transition?.definition).toEqual({ image: "synthetic-image-a", memory: 256 });
    f.backend.prepareTransition = () => {
      throw Error("Pending transitions must use retained configuration");
    };
    await new MachineController(f.store, f.backend, 100).step(scope);
    expect(f.reconciled[0]?.definition).toEqual({ image: "synthetic-image-a", memory: 256 });
    expect(f.dispatched).toHaveLength(1);
  });
  test("one physical create under concurrent coordinators and sibling demand", async () => {
    const f = fixture();
    await Promise.all([f.controller.acquire(scope, attempt), f.controller.acquire(scope, command)]);
    await Promise.all(Array.from({ length: 12 }, () => f.controller.step(scope)));
    expect(f.dispatched.map((item) => item.kind)).toEqual(["create"]);
    expect(f.store.row.state).toBe("running");
    expect(f.store.row.demands).toHaveLength(2);
  });
  test("background ownership survives loss of its observer", async () => {
    const f = fixture();
    await f.controller.acquire(scope, attempt);
    await f.controller.acquire(scope, command);
    await f.controller.step(scope);
    await f.controller.release(scope, attempt);
    f.time(1_000_000);
    await f.controller.step(scope);
    expect(f.dispatched.map((item) => item.kind)).toEqual(["create"]);
    expect(f.store.row.target).toBe("running");
  });
  test("idle grace begins after the last exact owner releases", async () => {
    const f = fixture();
    await f.controller.acquire(scope, command);
    await f.controller.step(scope);
    await f.controller.release(scope, { ...command, authority: "stale" });
    expect(f.store.row.demands).toHaveLength(1);
    await f.controller.release(scope, command);
    f.time(99);
    await f.controller.step(scope);
    expect(f.dispatched).toHaveLength(1);
    f.time(100);
    await f.controller.step(scope);
    expect(f.dispatched.map((item) => item.kind)).toEqual(["create", "suspend"]);
  });
  test("new demand cancels a reserved stop before its old dispatcher can act", async () => {
    const f = fixture();
    await f.controller.acquire(scope, attempt);
    await f.controller.step(scope);
    await f.controller.release(scope, attempt);
    f.time(100);
    const reserved = deferred<void>();
    const continueDispatch = deferred<void>();
    f.store.onWrite = async (next) => {
      if (next.transition?.kind === "suspend" && next.transition.phase === "reserved") {
        reserved.resolve();
        await continueDispatch.promise;
      }
    };
    const oldDispatcher = f.controller.step(scope);
    await reserved.promise;
    await f.controller.acquire(scope, command);
    continueDispatch.resolve();
    await oldDispatcher;
    expect(f.dispatched.map((item) => item.kind)).toEqual(["create"]);
    expect(f.store.row.transition).toBeNull();
  });
  test("demand waits for a dispatched stop; a late stop never follows resume", async () => {
    const f = fixture();
    await f.controller.acquire(scope, attempt);
    await f.controller.step(scope);
    await f.controller.release(scope, attempt);
    f.time(100);
    const reachedProvider = deferred<void>();
    const stopReceipt = deferred<TransitionResult>();
    f.backend.dispatch = async (_machine, transition) => {
      f.dispatched.push(transition);
      if (transition.kind === "suspend") {
        reachedProvider.resolve();
        return stopReceipt.promise;
      }
      return settled(transition);
    };
    const oldStop = f.controller.step(scope);
    await reachedProvider.promise;
    await f.controller.acquire(scope, command);
    await f.controller.step(scope);
    expect(f.dispatched.map((item) => item.kind)).toEqual(["create", "suspend"]);
    stopReceipt.resolve(settled(f.dispatched[1]!));
    await oldStop;
    expect(f.store.row.target).toBe("running");
    await f.controller.step(scope);
    expect(f.dispatched.map((item) => item.kind)).toEqual(["create", "suspend", "resume"]);
  });
  test("lost create reply never becomes a new create after coordinator death", async () => {
    const f = fixture();
    f.backend.dispatch = async (_machine, transition) => {
      f.dispatched.push(transition);
      throw new Error("synthetic lost reply");
    };
    await f.controller.acquire(scope, attempt);
    await f.controller.step(scope);
    const admittedId = f.store.row.transition!.id;
    const successor = new MachineController(
      f.store,
      f.backend,
      100,
      () => 10_000,
      () => "fresh-op",
    );
    for (let i = 0; i < 5; i++) await successor.step(scope);
    expect(f.dispatched).toHaveLength(1);
    expect(f.store.row.transition?.id).toBe(admittedId);
    expect(f.store.row.transition?.phase).toBe("unknown");
    expect(f.reconciled).toHaveLength(5);
    f.backend.reconcile = async (_machine, transition) => settled(transition);
    await successor.step(scope);
    expect(f.store.row.state).toBe("running");
  });
  test("crash after dispatch admission but before sending cannot be stolen", async () => {
    const f = fixture();
    await f.controller.acquire(scope, attempt);
    const blocker = deferred<void>();
    const admitted = deferred<void>();
    f.store.onWrite = async (next) => {
      if (next.transition?.phase === "dispatched") {
        admitted.resolve();
        await blocker.promise;
      }
    };
    const delayed = f.controller.step(scope);
    await admitted.promise;
    await f.controller.step(scope);
    expect(f.dispatched).toHaveLength(0);
    expect(f.reconciled).toHaveLength(1);
    blocker.resolve();
    await delayed;
    expect(f.dispatched).toHaveLength(1);
    expect(f.store.row.state).toBe("running");
  });
  test("destroy is monotonic and requires drained ownership", async () => {
    const f = fixture();
    await f.controller.acquire(scope, attempt);
    await expect(f.controller.requestDestroy(scope)).rejects.toThrow("Drain");
    await f.controller.release(scope, attempt);
    await f.controller.requestDestroy(scope);
    await expect(f.controller.acquire(scope, command)).rejects.toThrow("deletion");
    await f.controller.step(scope);
    expect(f.store.row.state).toBe("destroyed");
    await expect(f.controller.acquire(scope, attempt)).rejects.toThrow("deletion");
  });
  test("cancellation while loading cannot reserve or dispatch a new transition", async () => {
    const f = fixture();
    await f.controller.acquire(scope, attempt);
    const entered = deferred<void>();
    const gate = deferred<void>();
    const load = f.store.load.bind(f.store);
    f.store.load = async (machineScope) => {
      entered.resolve();
      await gate.promise;
      return load(machineScope);
    };
    const cancellation = new AbortController();
    const pending = f.controller.step(scope, { signal: cancellation.signal });
    await entered.promise;
    cancellation.abort();
    gate.resolve();
    await expect(pending).rejects.toThrow();
    expect(f.store.row.transition).toBeNull();
    expect(f.dispatched).toHaveLength(0);
  });
  test("cancellation during CAS retains reserved/dispatched identity without sending", async () => {
    for (const phase of ["reserved", "dispatched"] as const) {
      const f = fixture();
      await f.controller.acquire(scope, attempt);
      const entered = deferred<void>();
      const gate = deferred<void>();
      f.store.onWrite = async (next) => {
        if (next.transition?.phase === phase) {
          entered.resolve();
          await gate.promise;
        }
      };
      const cancellation = new AbortController();
      const pending = f.controller.step(scope, { signal: cancellation.signal });
      await entered.promise;
      cancellation.abort();
      gate.resolve();
      await expect(pending).rejects.toThrow();
      expect(f.store.row.transition?.phase).toBe(phase);
      expect(f.dispatched).toHaveLength(0);
    }
  });
  test("cancellation after dispatch preserves uncertainty and later recovery cannot redispatch", async () => {
    const f = fixture();
    await f.controller.acquire(scope, attempt);
    const entered = deferred<void>();
    const receipt = deferred<TransitionResult>();
    const cancellation = new AbortController();
    f.backend.dispatch = async (_machine, transition, options) => {
      expect(options?.signal).toBe(cancellation.signal);
      f.dispatched.push(transition);
      entered.resolve();
      return receipt.promise;
    };
    const pending = f.controller.step(scope, { signal: cancellation.signal });
    await entered.promise;
    cancellation.abort();
    receipt.resolve({ outcome: "unknown" });
    await expect(pending).rejects.toThrow();
    const id = f.store.row.transition!.id;
    expect(f.store.row.transition?.phase).toBe("dispatched");
    await f.controller.step(scope);
    expect(f.dispatched).toHaveLength(1);
    expect(f.reconciled).toHaveLength(1);
    expect(f.store.row.transition?.id).toBe(id);
    expect(f.store.row.transition?.phase).toBe("unknown");
  });
  test("persistent CAS contention yields without provider mutation", async () => {
    const f = fixture();
    await f.controller.acquire(scope, attempt);
    let writes = 0;
    f.store.compareAndSet = async () => {
      writes++;
      return false;
    };
    await expect(f.controller.step(scope)).rejects.toThrow("later pass");
    expect(writes).toBeLessThanOrEqual(100);
    expect(f.dispatched).toHaveLength(0);
    expect(f.store.row.demands).toEqual([attempt]);
  });
  test("a receipt for another operation cannot clear an unresolved start", async () => {
    const f = fixture();
    f.backend.dispatch = async () => ({
      outcome: "settled",
      transitionId: "other-op",
      state: "running",
      instance: { id: "x", bootId: "x", diskLineage: "x" },
      disk: "x",
    });
    await f.controller.acquire(scope, attempt);
    await expect(f.controller.step(scope)).rejects.toThrow("Invalid terminal");
    expect(f.store.row.transition?.phase).toBe("dispatched");
  });
});

describe("sandbox v2 engine selection", () => {
  const admission = {
    deploymentEnabled: true,
    workspaceEnabled: true,
    recorded: null,
    isNewGroup: true,
    backend: "docker",
    qualifiedBackends: new Set(["docker"]),
  } as const;
  test("default-off and workspace opt-in both matter", () => {
    expect(selectSandboxEngine({ ...admission, deploymentEnabled: false })).toBe("legacy");
    expect(selectSandboxEngine({ ...admission, workspaceEnabled: false })).toBe("legacy");
    expect(selectSandboxEngine(admission)).toBe("machine-v2");
    expect(selectSandboxEngine({ ...admission, qualifiedBackends: new Set() })).toBe("legacy");
    expect(selectSandboxEngine({ ...admission, backend: "unqualified" })).toBe("legacy");
  });
  test("flag changes never reinterpret persisted groups", () => {
    expect(selectSandboxEngine({ ...admission, recorded: "legacy" })).toBe("legacy");
    expect(
      selectSandboxEngine({ ...admission, deploymentEnabled: false, recorded: "machine-v2" }),
    ).toBe("machine-v2");
    expect(selectSandboxEngine({ ...admission, isNewGroup: false })).toBe("legacy");
  });
  test("Connected Machines and host execution keep their ownership path", () => {
    for (const backend of ["none", "local", "selfhosted"])
      expect(selectSandboxEngine({ ...admission, backend })).toBe("legacy");
  });
});
