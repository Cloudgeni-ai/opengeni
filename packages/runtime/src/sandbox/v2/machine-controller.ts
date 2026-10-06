import { randomUUID } from "node:crypto";
import {
  initialSandboxMachine,
  type SandboxMachineState,
  type SandboxMachineTarget,
  type SandboxMachineScope,
  type SandboxMachineInstance,
  type SandboxMachineDemand,
  type SandboxMachineTransition,
  type SandboxMachineRecord,
} from "@opengeni/contracts";

export type MachineState = SandboxMachineState;
export type MachineTarget = SandboxMachineTarget;
export type MachineScope = SandboxMachineScope;
export type MachineInstance = SandboxMachineInstance;
export type MachineDemand = SandboxMachineDemand;
export type MachineTransition = SandboxMachineTransition;
export type MachineRecord = SandboxMachineRecord;

/** Each compare-and-set is one durable, scope-checked transaction. Network calls
 * never run inside it. Ownership expiry cannot reset a dispatched transition. */
export interface MachineStore {
  load(scope: MachineScope): Promise<MachineRecord>;
  compareAndSet(previous: MachineRecord, next: MachineRecord): Promise<boolean>;
}

export type TransitionProof = {
  transitionId: string;
  /** Proof that this exact mutation can no longer change the machine's later
   * state or resources. A current-state observation or timeout is insufficient.
   * Multi-resource destruction may settle a durable intermediate step. */
  outcome: "settled";
  state: MachineState;
  instance: MachineInstance | null;
  disk: MachineRecord["disk"];
};
export type TransitionResult = TransitionProof | { outcome: "unknown" };
export type MachineLifecycleOptions = { signal?: AbortSignal };
export interface MachineBackend {
  readonly provider: string;
  /** Pure, synchronous preparation before durable admission. No provider I/O or
   * credentials; the returned configuration is retained with this transition. */
  prepareTransition?(
    machine: MachineRecord,
    kind: MachineTransition["kind"],
  ): MachineTransition["definition"];
  /** Called at most once by the coordinator for this transition. A backend may
   * retry only with native deduplication that also fences delayed requests. */
  dispatch(
    machine: MachineRecord,
    transition: MachineTransition,
    options?: MachineLifecycleOptions,
  ): Promise<TransitionResult>;
  /** Read-only reconciliation; never infer terminal proof from generic status. */
  reconcile(
    machine: MachineRecord,
    transition: MachineTransition,
    options?: MachineLifecycleOptions,
  ): Promise<TransitionResult>;
}

export class MachineConflictError extends Error {
  readonly code = "SANDBOX_V2_CONFLICT";
}

export function newMachine(
  scope: MachineScope,
  provider: string,
  id = randomUUID(),
): MachineRecord {
  return initialSandboxMachine(scope, provider, id);
}

function copy(machine: MachineRecord): MachineRecord {
  return structuredClone(machine);
}
function nextVersion(machine: MachineRecord): MachineRecord {
  const next = copy(machine);
  next.version += 1;
  if (!Number.isSafeInteger(next.version))
    throw new MachineConflictError("Machine version exhausted");
  return next;
}
function sameDemand(left: MachineDemand, right: MachineDemand): boolean {
  return (
    left.id === right.id &&
    left.owner === right.owner &&
    left.kind === right.kind &&
    left.authority === right.authority
  );
}

/** Pure lifecycle policy plus durable mutation admission. A crash after admission
 * can delay progress, but cannot license another create/start/stop operation. */
export class MachineController {
  constructor(
    private readonly store: MachineStore,
    private readonly backend: MachineBackend,
    private readonly idleGraceMs: number,
    private readonly now: () => number = Date.now,
    private readonly operationId: () => string = randomUUID,
  ) {
    if (!Number.isFinite(idleGraceMs) || idleGraceMs < 0)
      throw new MachineConflictError("Invalid idle grace period");
  }

  private async mutate(
    scope: MachineScope,
    change: (machine: MachineRecord) => void,
    options: MachineLifecycleOptions = {},
  ): Promise<MachineRecord> {
    for (let contention = 0; contention < 100; contention++) {
      options.signal?.throwIfAborted();
      const previous = await this.store.load(scope);
      options.signal?.throwIfAborted();
      const next = nextVersion(previous);
      change(next);
      options.signal?.throwIfAborted();
      if (await this.store.compareAndSet(previous, next)) return next;
    }
    throw new MachineConflictError("Machine mutation contention requires a later pass");
  }

  async acquire(scope: MachineScope, demand: MachineDemand): Promise<MachineRecord> {
    if (!demand.id || !demand.owner || !demand.authority)
      throw new MachineConflictError("Incomplete machine demand identity");
    return this.mutate(scope, (machine) => {
      if (machine.target === "destroyed" || machine.state === "destroyed")
        throw new MachineConflictError("Machine deletion has already been admitted");
      const existing = machine.demands.find((item) => item.id === demand.id);
      if (existing && !sameDemand(existing, demand))
        throw new MachineConflictError("Machine demand ID was reused");
      if (!existing) machine.demands.push(structuredClone(demand));
      machine.target = "running";
      machine.idleSince = null;
      // A dispatcher must CAS reserved -> dispatched before any network action.
      // Cancelling this reserved intent makes a delayed dispatcher lose that CAS.
      if (machine.transition?.kind === "suspend" && machine.transition.phase === "reserved")
        machine.transition = null;
    });
  }

  /** Call only after the control plane has drained/revoked this exact owner.
   * An observer timeout alone never releases an attempt or background command. */
  async release(scope: MachineScope, demand: MachineDemand): Promise<MachineRecord> {
    return this.mutate(scope, (machine) => {
      machine.demands = machine.demands.filter((item) => !sameDemand(item, demand));
      if (machine.demands.length === 0 && machine.idleSince === null)
        machine.idleSince = this.now();
    });
  }

  async requestDestroy(scope: MachineScope): Promise<MachineRecord> {
    return this.mutate(scope, (machine) => {
      if (machine.demands.length)
        throw new MachineConflictError("Drain machine owners before destruction");
      machine.target = "destroyed";
    });
  }

  private kind(machine: MachineRecord): MachineTransition["kind"] | null {
    if (machine.state === "destroyed") return null;
    if (machine.target === "destroyed") return "destroy";
    if (machine.target === "running") {
      if (machine.state === "absent") return "create";
      if (machine.state === "suspended") return "resume";
    }
    if (machine.target === "suspended" && machine.state === "running") return "suspend";
    return null;
  }

  private assertProof(transition: MachineTransition, proof: TransitionProof): void {
    const expected: MachineState =
      transition.kind === "create" || transition.kind === "resume"
        ? "running"
        : transition.kind === "suspend"
          ? "suspended"
          : "destroyed";
    if (
      proof.transitionId !== transition.id ||
      (transition.kind === "create"
        ? proof.state !== "running" && proof.state !== "suspended"
        : transition.kind === "destroy"
          ? proof.state !== "destroyed" && proof.state !== "destroying"
          : proof.state !== expected) ||
      (proof.state !== "destroyed" && proof.disk === null) ||
      (proof.state === "running" &&
        (!proof.instance?.id || !proof.instance.bootId || !proof.instance.diskLineage)) ||
      (proof.state === "destroyed" && (proof.instance !== null || proof.disk !== null)) ||
      (proof.state === "destroying" && proof.instance !== null)
    )
      throw new MachineConflictError("Invalid terminal machine transition proof");
  }

  private async settle(
    scope: MachineScope,
    transition: MachineTransition,
    result: TransitionResult,
    options: MachineLifecycleOptions = {},
  ): Promise<MachineRecord> {
    if (result.outcome === "settled") this.assertProof(transition, result);
    return this.mutate(
      scope,
      (machine) => {
        if (machine.transition?.id !== transition.id) return;
        if (result.outcome === "unknown") {
          machine.transition.phase = "unknown";
          return;
        }
        machine.state = result.state;
        machine.instance = structuredClone(result.instance);
        machine.disk = structuredClone(result.disk);
        machine.transition = null;
        // New demand may have arrived while a dispatched stop was settling. Preserve
        // its target; the next step resumes only after this stop's terminal proof.
      },
      options,
    );
  }

  /** Performs at most one provider mutation. A scheduler calls it again after a
   * state change; pending unknown work is reconciled without redispatch. */
  async step(scope: MachineScope, options: MachineLifecycleOptions = {}): Promise<MachineRecord> {
    for (let contention = 0; contention < 100; contention++) {
      options.signal?.throwIfAborted();
      const machine = await this.store.load(scope);
      options.signal?.throwIfAborted();
      if (machine.provider !== this.backend.provider)
        throw new MachineConflictError("Machine backend binding changed");
      if (machine.transition && machine.transition.phase !== "reserved") {
        const result = await this.backend.reconcile(
          copy(machine),
          structuredClone(machine.transition),
          options,
        );
        options.signal?.throwIfAborted();
        return this.settle(scope, machine.transition, result, options);
      }
      if (!machine.transition) {
        const next = nextVersion(machine);
        if (
          next.target !== "destroyed" &&
          next.demands.length === 0 &&
          next.idleSince !== null &&
          this.now() - next.idleSince >= this.idleGraceMs
        )
          next.target = "suspended";
        const kind = this.kind(next);
        if (!kind) {
          if (next.target === machine.target) return machine;
          options.signal?.throwIfAborted();
          if (await this.store.compareAndSet(machine, next)) return next;
          continue;
        }
        const definition = this.backend.prepareTransition?.(copy(next), kind);
        next.transition = {
          id: this.operationId(),
          kind,
          phase: "reserved",
          ...(definition === undefined ? {} : { definition: structuredClone(definition) }),
          before: {
            state: machine.state,
            instance: structuredClone(machine.instance),
            disk: structuredClone(machine.disk),
          },
        };
        options.signal?.throwIfAborted();
        if (!(await this.store.compareAndSet(machine, next))) continue;
        // Re-read after persisting, so current demand can cancel an idle intent.
        continue;
      }
      const dispatched = nextVersion(machine);
      dispatched.transition!.phase = "dispatched";
      options.signal?.throwIfAborted();
      if (!(await this.store.compareAndSet(machine, dispatched))) continue;
      // Abort after the durable dispatch marker preserves it. A cancelled
      // observer cannot reset uncertainty or send a new physical mutation.
      options.signal?.throwIfAborted();
      const transition = dispatched.transition!;
      let result: TransitionResult;
      try {
        result = await this.backend.dispatch(
          copy(dispatched),
          structuredClone(transition),
          options,
        );
      } catch {
        // Rejection, timeout and disconnect do not establish physical absence.
        result = { outcome: "unknown" };
      }
      options.signal?.throwIfAborted();
      return this.settle(scope, transition, result, options);
    }
    throw new MachineConflictError("Machine lifecycle contention requires a later pass");
  }
}
