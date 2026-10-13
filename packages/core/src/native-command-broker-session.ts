import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { readImmutableServerSourceSha } from "@opengeni/config/server-source-identity";
import {
  inspectNativeCommandProviderQualification,
  loadNativeBrokerBootstrapAdmission,
  loadNativeCommandBirthQualification,
  validateQualifiedNativeBrokerPlan,
  readLease,
  type Database,
  type NativeBrokerBootstrapAdmissionInput,
  type NativeCommandQualificationScope,
} from "@opengeni/db";
import {
  installModalNativeBrokerSession,
  modalNativeBrokerSessionContext,
  NativeBrokerCommandSession,
  NativeBrokerCoordinator,
  resolveModalCheckpointProviderBindingForSession,
  readModalNativeBrokerCreate,
  type ModalCreateLifecycle,
  type ModalNativeBrokerChannel,
} from "@opengeni/runtime/sandbox";
import { registerQualifiedNativeBrokerBootstrap } from "./native-command-broker-transport";

type Context = ReturnType<typeof modalNativeBrokerSessionContext>;
type Registered = Awaited<ReturnType<typeof registerQualifiedNativeBrokerBootstrap>>;
type Physical = Registered & {
  channel: ModalNativeBrokerChannel;
  coordinator: NativeBrokerCoordinator;
};
type Entry = {
  db: Database;
  keyDigest: string;
  references: number;
  controller: AbortController;
  ready: Promise<Physical>;
  closing: Promise<void> | null;
};

// One coordinator per exact physical enrollment in this host process, shared
// by turn, API and viewer wrappers. Different hosts remain DB-writer fenced.
// Entries disappear only after their actual output/input ownership is joined.
const physicalOwners = new Map<string, Entry>();
const attached = new WeakMap<object, { scopeKey: string; ready: Promise<void>; closed: boolean }>();

async function interested<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function acquirePhysical(
  db: Database,
  key: Uint8Array,
  input: NativeBrokerBootstrapAdmissionInput,
  context: Context,
  signal?: AbortSignal,
) {
  const identity = JSON.stringify([
    input.accountId,
    input.workspaceId,
    input.sandboxGroupId,
    input.leaseId,
    input.createOperationId,
    input.sandboxId,
    input.sourceSha,
    input.providerBindingKey,
  ]);
  const keyDigest = createHash("sha256").update(key).digest("hex");
  let entry = physicalOwners.get(identity);
  if (entry?.closing) {
    await interested(entry.closing, signal);
    return await acquirePhysical(db, key, input, context, signal);
  }
  if (entry && (entry.db !== db || entry.keyDigest !== keyDigest))
    throw new Error("Native broker host owner changed database or encryption identity");
  if (!entry) {
    const controller = new AbortController();
    const ready = (async (): Promise<Physical> => {
      const channel = await context.connect(controller.signal);
      try {
        const registered = await registerQualifiedNativeBrokerBootstrap(
          db,
          key,
          input,
          channel,
          controller.signal,
        );
        return {
          ...registered,
          channel,
          coordinator: new NativeBrokerCoordinator(registered.journal, channel, randomUUID()),
        };
      } catch (error) {
        channel.close();
        throw error;
      }
    })();
    entry = { db, keyDigest, references: 0, controller, ready, closing: null };
    physicalOwners.set(identity, entry);
  }
  const owner = entry;
  owner.references++;
  let released: Promise<void> | undefined;
  const release = () =>
    (released ??= (async () => {
      owner.references--;
      if (owner.references !== 0) return;
      owner.controller.abort(new Error("Native broker has no remaining host surfaces"));
      owner.closing = (async () => {
        let physical: Physical;
        try {
          physical = await owner.ready;
        } catch {
          // Failed construction has already closed its channel; the original
          // rejection remains visible to every acquiring caller.
          if (physicalOwners.get(identity) === owner) physicalOwners.delete(identity);
          return;
        }
        try {
          await physical.coordinator.close();
        } finally {
          physical.channel.close();
        }
        // A failed join retains this closing owner as a quarantine. A successor
        // must not overlap an observer whose disposal could not be established.
        if (physicalOwners.get(identity) === owner) physicalOwners.delete(identity);
      })();
      await owner.closing;
    })());
  try {
    return { physical: await interested(owner.ready, signal), release };
  } catch (error) {
    await release();
    throw error;
  }
}

/** Application composition for an already-attributed exact Modal wrapper.
 * Legacy births return unchanged before provider I/O. Broker births require
 * the frozen source, original physical create, authenticated namespace and
 * bootstrap evidence. Warm recovery cannot register missing initial evidence.
 * Installation still does not admit a command: routing owns that separately. */
export async function attachQualifiedModalNativeBrokerSession(input: {
  db: Database;
  settings: Settings;
  scope: NativeCommandQualificationScope;
  session: unknown;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { db, settings, signal } = input;
  const scope = {
    accountId: input.scope.accountId,
    workspaceId: input.scope.workspaceId,
    sandboxGroupId: input.scope.sandboxGroupId,
  };
  signal?.throwIfAborted();
  const birth = await loadNativeCommandBirthQualification(db, scope);
  if (!birth?.brokerArtifact) return false;
  const sourceSha = await readImmutableServerSourceSha();
  if (!sourceSha || sourceSha !== birth.sourceSha)
    throw new Error("Native broker session host source is not its frozen qualified source");
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) throw new Error("Native broker session requires encrypted durable transport");
  const context = modalNativeBrokerSessionContext(input.session);
  const scopeKey = JSON.stringify([
    scope.accountId,
    scope.workspaceId,
    scope.sandboxGroupId,
    sourceSha,
    createHash("sha256").update(key).digest("hex"),
  ]);
  const existing = attached.get(context.session);
  if (existing) {
    if (existing.closed || existing.scopeKey !== scopeKey)
      throw new Error("Native broker wrapper cannot change its original attachment scope");
    await interested(existing.ready, signal);
    return true;
  }
  const install = async () => {
    const provider = await resolveModalCheckpointProviderBindingForSession(
      settings,
      context.session,
    );
    const lease = await readLease(db, scope.workspaceId, scope.sandboxGroupId);
    const create = lease?.providerCreateAttempt;
    if (
      !lease ||
      !create ||
      !create.nativeBroker ||
      lease.instanceId !== context.sandboxId ||
      create.instanceId !== context.sandboxId ||
      create.providerBindingKey !== provider.key ||
      provider.key !== birth.providerBindingKey
    )
      throw new Error("Native broker session has no exact original physical creation");
    const admission: NativeBrokerBootstrapAdmissionInput = {
      ...scope,
      leaseId: lease.id,
      createOperationId: create.operationId,
      sandboxId: context.sandboxId,
      sourceSha,
      providerBindingKey: provider.key,
    };
    const first = await loadNativeBrokerBootstrapAdmission(db, admission);
    const ownership = await acquirePhysical(db, key, admission, context, signal);
    const { physical } = ownership;
    try {
      const recheck = async (currentSignal?: AbortSignal) => {
        currentSignal?.throwIfAborted();
        const current = await loadNativeBrokerBootstrapAdmission(db, admission);
        if (
          !isDeepStrictEqual(current.binding, first.binding) ||
          !isDeepStrictEqual(current.artifact, first.artifact)
        )
          throw new Error("Native broker session qualification changed during attachment");
        currentSignal?.throwIfAborted();
        return current;
      };
      await recheck(signal);
      const commands = new NativeBrokerCommandSession({
        journal: physical.journal,
        coordinator: physical.coordinator,
        identity: physical.binding,
        root: context.root,
        environment: context.environment,
        verify: async (protocol) => {
          const current = await recheck();
          if (current.phase !== "warm")
            throw new Error("Native broker commands require a warm lease");
          const decision = await inspectNativeCommandProviderQualification(db, {
            ...scope,
            sourceSha,
            protocol,
            providerInstanceId: context.sandboxId,
            leaseEpoch: physical.binding.createEpoch + 1,
          });
          if (decision.status !== "enrolled")
            throw new Error("Native broker command qualification is unavailable");
          return { sandboxId: physical.binding.sandboxId, taskId: physical.binding.taskId };
        },
      });
      installModalNativeBrokerSession(
        context.session,
        commands,
        async () => {
          const original = attached.get(context.session);
          if (original) original.closed = true;
          try {
            await ownership.release();
          } finally {
            context.closeTransport();
          }
        },
        async (currentSignal) => {
          await recheck(currentSignal);
          await physical.coordinator.checkDiagnostics(currentSignal);
          await recheck(currentSignal);
        },
      );
    } catch (error) {
      await ownership.release();
      throw error;
    }
  };
  const pending = install();
  const attachment = { scopeKey, ready: pending, closed: false };
  attached.set(context.session, attachment);
  try {
    await pending;
    return true;
  } catch (error) {
    if (attached.get(context.session) === attachment) attached.delete(context.session);
    context.closeTransport();
    throw error;
  }
}

/** Host-only disposal is deliberately separate from the SDK's legacy close,
 * which may delete a physical sandbox. Call only after this caller has stopped
 * using the wrapper; physical drain/retained-command proof remains upstream. */
export async function closeQualifiedModalNativeBrokerSession(session: unknown): Promise<void> {
  if (!session || typeof session !== "object") return;
  const attachment = attached.get(session);
  if (!attachment) return;
  await attachment.ready;
  await (session as Context["session"]).close();
}

/** Select only the group's original operator-qualified broker birth. A fresh
 * UUID is a proposed physical broker identity, not replay or enrollment. The
 * ordinary lease admission still persists the exact issued create intent. */
export async function qualifiedModalNativeBrokerCreateLifecycle(input: {
  db: Database;
  settings: Settings;
  scope: NativeCommandQualificationScope;
  signal?: AbortSignal;
}): Promise<ModalCreateLifecycle["nativeBroker"]> {
  input.signal?.throwIfAborted();
  const birth = await loadNativeCommandBirthQualification(input.db, input.scope);
  if (!birth?.brokerArtifact) return undefined;
  const sourceSha = await readImmutableServerSourceSha();
  if (
    !sourceSha ||
    sourceSha !== birth.sourceSha ||
    input.settings.modalImageRef !== birth.imageRef
  )
    throw new Error("Native broker creation requires its exact qualified source and image");
  if (!environmentsEncryptionKeyBytes(input.settings))
    throw new Error("Native broker creation requires encrypted durable transport");
  const plan = validateQualifiedNativeBrokerPlan(birth, {
    version: 1,
    brokerId: randomUUID(),
    sourceSha,
    imageId: birth.providerImageId,
    artifact: birth.brokerArtifact,
  })!;
  return {
    plan,
    beforeDispatch: async (intent) => {
      input.signal?.throwIfAborted();
      const proof = readModalNativeBrokerCreate(intent);
      if (!proof || !isDeepStrictEqual(proof.plan, plan))
        throw new Error("Native broker creation lost its issued physical recipe");
    },
    verifyCreated: async (session) => {
      input.signal?.throwIfAborted();
      if (!(await attachQualifiedModalNativeBrokerSession({ ...input, session })))
        throw new Error("Native broker physical receipt lost its original qualification");
      input.signal?.throwIfAborted();
    },
  };
}
