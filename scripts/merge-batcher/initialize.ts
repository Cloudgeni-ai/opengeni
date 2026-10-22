/** Operator-only initialization. Importing this module never writes remotely. */
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { AtomicGitWriter, GitStore } from "./git";
import { canonical, emptyLedger, type Ledger } from "./model";

export interface StoppedInitializationObservation {
  serviceUid: string;
  serviceGeneration: string;
  image: string;
  stopGeneration: string;
  observedAt: string;
  manualZero: boolean;
  stopPersisted: boolean;
  writerExited: boolean;
  routingSafe: boolean;
  instances: number;
  instancesComplete: boolean;
  pendingEffects: boolean;
}
export interface InitializationDependencies {
  // A reviewed provider adapter must read current STOP/control, service and
  // complete timestamped instance evidence, not accept an operator assertion.
  observeStopped(): Promise<StoppedInitializationObservation>;
  // Permanent operator journal, exclusively created and synced before push.
  // Existing intent (including an unknown outcome) refuses, never replays.
  reserve(intent: unknown): Promise<void>;
  record(result: unknown): Promise<void>;
  now(): Date;
}
export async function reserveInitialization(path: string, intent: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(canonical(intent));
    await file.sync();
  } finally {
    await file.close();
  }
  // Persist the new directory entry as well as the intent's bytes.
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function assertStopped(value: StoppedInitializationObservation, now: Date): void {
  const age = now.getTime() - Date.parse(value.observedAt);
  if (
    !value.serviceUid ||
    !/^[1-9][0-9]*$/.test(value.serviceGeneration) ||
    !/@sha256:[a-f0-9]{64}$/.test(value.image) ||
    !value.stopGeneration ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 120000 ||
    value.manualZero !== true ||
    value.stopPersisted !== true ||
    value.writerExited !== true ||
    value.routingSafe !== true ||
    value.instancesComplete !== true ||
    value.instances !== 0 ||
    value.pendingEffects !== false
  )
    throw new Error(
      "Initialization requires fresh proven OFF, zero instances and no pending effects",
    );
}
function identity(value: StoppedInitializationObservation): string {
  return canonical([value.serviceUid, value.serviceGeneration, value.image, value.stopGeneration]);
}
function virgin(refs: Map<string, string>, stateRef: string): void {
  if (refs.has(stateRef)) throw new Error("State already exists; initialization refuses");
  if (!refs.has("refs/heads/main")) throw new Error("Main observation incomplete");
  // Historical shadow is a separately fenced read-only-main namespace. All
  // other queue refs (including malformed/live/base/reservation refs) block.
  if (
    [...refs.keys()].some(
      (ref) =>
        ref.startsWith("refs/heads/queue/") && !ref.startsWith("refs/heads/queue/shadow-traffic/"),
    )
  )
    throw new Error("Active or unclassified queue reservation exists");
}
export async function initializeActiveState(
  git: GitStore,
  writer: AtomicGitWriter,
  deps: InitializationDependencies,
): Promise<{ stateSha: string; initialization: NonNullable<Ledger["initialization"]> }> {
  if (writer.stateRef !== "refs/heads/batcher-state" || writer.baseRef !== "refs/heads/main")
    throw new Error("Unsupported initialization namespace");
  const stopped = await deps.observeStopped();
  assertStopped(stopped, deps.now());
  const before = await git.remoteRefs(writer.remote);
  virgin(before, writer.stateRef);
  const initialization = {
    schemaVersion: 1 as const,
    operationId: randomUUID(),
    serviceUid: stopped.serviceUid,
    serviceGeneration: stopped.serviceGeneration,
    initializedAt: deps.now().toISOString(),
  };
  const ledger = { ...emptyLedger(), initialization };
  const stateSha = await git.stateCommit(ledger, null, initialization.initializedAt);
  // Refuse changed service/main/namespace before reserving the one attempt.
  const second = await deps.observeStopped();
  assertStopped(second, deps.now());
  if (identity(stopped) !== identity(second)) throw new Error("Stopped deployment changed");
  const next = await git.remoteRefs(writer.remote);
  virgin(next, writer.stateRef);
  if (next.get(writer.baseRef) !== before.get(writer.baseRef)) throw new Error("Main moved");
  await deps.reserve({
    initialization,
    stateSha,
    stateRef: writer.stateRef,
    remote: writer.remote,
  });
  try {
    // Exactly one create-only transaction. Even a lost success response remains
    // an unknown intent for explicit read-only reconciliation, never a retry.
    await writer.transaction([{ ref: writer.stateRef, expected: null, next: stateSha }]);
    const after = await git.remoteRefs(writer.remote);
    const final = await deps.observeStopped();
    assertStopped(final, deps.now());
    if (identity(final) !== identity(stopped) || after.get(writer.stateRef) !== stateSha)
      throw new Error("Initialization outcome changed");
    const withoutState = new Map(after);
    withoutState.delete(writer.stateRef);
    virgin(withoutState, writer.stateRef);
    if (after.get(writer.baseRef) !== before.get(writer.baseRef)) throw new Error("Main moved");
    await deps.record({ outcome: "initialized", stateSha, initialization });
    return { stateSha, initialization };
  } catch {
    await deps.record({ outcome: "unknown-hold", stateSha, initialization });
    throw new Error("Initialization outcome requires read-only reconciliation; never replay");
  }
}
