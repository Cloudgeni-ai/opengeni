import {
  nativeBrokerTransportStore,
  registerNativeBrokerTransport,
  findNativeBrokerTransportBinding,
  type NativeBrokerTransportBinding,
} from "@opengeni/db/native-command-broker-transport";
import {
  loadNativeBrokerBootstrapAdmission,
  type NativeBrokerBootstrapAdmissionInput,
  type Database,
} from "@opengeni/db";
import { isDeepStrictEqual } from "node:util";
import {
  durableNativeBrokerTransport,
  captureNativeBrokerBootstrap,
  readNativeBrokerBootstrap,
  type NativeBrokerArtifactPin,
  type NativeBrokerChannel,
} from "@opengeni/runtime/sandbox";

/** Package-boundary composition only; no API route or runtime admission uses
 * this before the complete broker protocol and artifact are qualified. */
export function createDurableNativeBrokerTransport(
  db: Database,
  encryptionKey: Uint8Array,
  binding: NativeBrokerTransportBinding,
) {
  return durableNativeBrokerTransport(
    nativeBrokerTransportStore(db, encryptionKey, binding),
    binding,
  );
}

/** Compose the frozen owner-qualified creation with exact authenticated
 * initial-channel capture. This still grants no command authority: initial
 * stderr, live command admission and the session adapter remain separate.
 * Warm recovery requires existing retained evidence and never reads a new
 * prefix or retrospectively registers an already-running sandbox. */
export async function registerQualifiedNativeBrokerBootstrap(
  db: Database,
  encryptionKey: Uint8Array,
  input: NativeBrokerBootstrapAdmissionInput,
  channel: Pick<NativeBrokerChannel, "sandboxId" | "taskId" | "output">,
  signal?: AbortSignal,
) {
  const scope = structuredClone(input);
  signal?.throwIfAborted();
  const admitted = await loadNativeBrokerBootstrapAdmission(db, scope);
  const selected = { ...admitted.binding, taskId: channel.taskId };
  if (channel.sandboxId !== selected.sandboxId)
    throw new Error("Qualified native broker initial channel changed its sandbox identity");
  if (admitted.phase === "warm" && !(await findNativeBrokerTransportBinding(db, selected)))
    throw new Error("Warm native broker requires its existing durable bootstrap evidence");
  const captured = await registerCapturedNativeBrokerBootstrap(
    db,
    encryptionKey,
    selected,
    channel,
    admitted.artifact,
    signal,
  );
  // No provider I/O while a DB transaction is held. Recheck after capture: a
  // lost/replaced/draining lease cannot become an application startup result.
  const current = await loadNativeBrokerBootstrapAdmission(db, scope);
  if (
    !isDeepStrictEqual(current.binding, admitted.binding) ||
    !isDeepStrictEqual(current.artifact, admitted.artifact)
  )
    throw new Error("Native broker bootstrap qualification changed during capture");
  signal?.throwIfAborted();
  return Object.freeze({ ...captured, commandAdmission: false as const });
}

/** Fresh, already-attributed initial channel only. This closes the prefix
 * retention boundary, not source qualification, initial-stderr validation or
 * application command admission. Unknown commits replay identical evidence;
 * neither recovery nor this helper sends any input to the physical broker. */
export async function registerCapturedNativeBrokerBootstrap(
  db: Database,
  encryptionKey: Uint8Array,
  input: Omit<NativeBrokerTransportBinding, "bootstrapEvidenceSha256">,
  channel: Pick<NativeBrokerChannel, "sandboxId" | "taskId" | "output">,
  expected: NativeBrokerArtifactPin,
  signal?: AbortSignal,
) {
  const scope = structuredClone(input);
  // Structural callers may pass the complete old binding. The source of the
  // evidence digest is the durable row or newly verified bytes, never input.
  const { bootstrapEvidenceSha256: _ignored, ...selected } = scope as typeof scope & {
    bootstrapEvidenceSha256?: unknown;
  };
  const pin = { ...expected };
  if (
    scope.artifactSha256 !== pin.artifactSha256 ||
    scope.sandboxId !== channel.sandboxId ||
    scope.taskId !== channel.taskId
  )
    throw new Error("Native broker initial channel does not match its selected artifact and scope");
  signal?.throwIfAborted();
  let binding = await findNativeBrokerTransportBinding(db, selected);
  signal?.throwIfAborted();
  if (!binding) {
    const captured = await captureNativeBrokerBootstrap(channel, scope.brokerId, pin, signal);
    signal?.throwIfAborted();
    binding = {
      ...selected,
      bootstrapEvidenceSha256: captured.bootstrap.transcriptSha256,
    };
    await registerNativeBrokerTransport(
      db,
      encryptionKey,
      binding,
      captured.initialState,
      captured.entries,
    );
  }
  Object.freeze(binding);
  const journal = createDurableNativeBrokerTransport(db, encryptionKey, binding);
  const bootstrap = await readNativeBrokerBootstrap(journal, pin);
  if (bootstrap.transcriptSha256 !== binding.bootstrapEvidenceSha256)
    throw new Error("Native broker durable bootstrap differs from captured evidence");
  return Object.freeze({ binding, bootstrap, journal });
}
