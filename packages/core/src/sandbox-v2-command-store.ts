import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  abandonSandboxJournalOperation,
  abandonUnboundSandboxJournalControl,
  allocateSandboxJournalOperation,
  findSandboxJournalOperationId,
  assertSandboxJournalCommand,
  assertSandboxJournalControl,
  captureSandboxJournalOutput,
  loadSandboxJournalCommand,
  loadSandboxJournalCapturedOutput,
  loadSandboxJournalToolReply,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  recordSandboxJournalControlProof,
  reserveSandboxJournalCommand,
  reserveSandboxJournalInput,
  settleSandboxJournalControl,
  type Database,
  type SandboxJournalControlAuthority,
  type SandboxJournalTurnAuthority,
} from "@opengeni/db";
import {
  JournalBindingError,
  MachineJournalClient,
  MachineSandboxSession,
  type JournalCommand,
  type MachineExecTransport,
  type MachineSessionPersistence,
} from "@opengeni/runtime/sandbox";

/** Trusted causal composition, not execution authority. Encode every physical
 * action, including the root, so a raw model call ID cannot alias a child key.
 * Compound tools must use explicit stable keys; counters, fresh UUIDs and the
 * current command body do not identify a retried step. */
export function sandboxV2CausalActionId(acceptedActionId: string, operationKey = ""): string {
  if (
    typeof acceptedActionId !== "string" ||
    !acceptedActionId ||
    acceptedActionId.length > 512 ||
    typeof operationKey !== "string" ||
    !/^[a-zA-Z0-9_./:-]{0,128}$/u.test(operationKey)
  )
    throw new JournalBindingError("Invalid accepted sandbox operation identity");
  return `sandbox-v2:${createHash("sha256")
    .update(JSON.stringify(["sandbox-v2-operation-v1", acceptedActionId, operationKey]))
    .digest("hex")}`;
}

/** Each session composition binds one retained worker tool-action receipt. Its
 * causal identity never comes from a guest handle or arbitrary tool arguments.
 * This turn-owned path cannot adopt commands or settle a revoked attempt; those
 * require the control reconciler's separate authority. */
export function createSandboxV2CommandPersistence(
  db: Database,
  authority: SandboxJournalTurnAuthority,
  operationKey = "",
): MachineSessionPersistence {
  const context = structuredClone(authority);
  context.acceptedActionId = sandboxV2CausalActionId(context.acceptedActionId, operationKey);
  return {
    findOperationId: (input) => findSandboxJournalOperationId(db, context, input.requestDigest),
    allocateOperationId: (input) =>
      allocateSandboxJournalOperation(db, context, input.requestDigest),
    abandonOperationId: (operationId) => abandonSandboxJournalOperation(db, context, operationId),
    reserve: (command) => reserveSandboxJournalCommand(db, context, command),
    assert: (command, action) => assertSandboxJournalCommand(db, context, command, action),
    load: (handle) => loadSandboxJournalCommand(db, context, { handle }),
    loadOperation: (operationId) => loadSandboxJournalCommand(db, context, { operationId }),
    loadCapturedOutput: (command, options) =>
      loadSandboxJournalCapturedOutput(db, context, command, options),
    handleFor: async (command) => {
      const row = await loadSandboxJournalCommand(db, context, {
        operationId: command.operationId,
      });
      if (!row || !isDeepStrictEqual(row.command, command))
        throw new JournalBindingError("No durable command alias");
      return row.handle;
    },
    reserveInput: (command, input) =>
      reserveSandboxJournalInput(db, context, {
        command,
        requestDigest: input.requestDigest,
        partIndex: input.partIndex,
        partCount: input.partCount,
        actionDigest: createHash("sha256").update(JSON.stringify(input.action)).digest("hex"),
      }),
    capture: (input) => captureSandboxJournalOutput(db, context, input),
    recordControlProof: (command, observation) =>
      recordSandboxJournalControlProof(db, context, command, observation),
  };
}

/** Worker seam for one accepted function call. Register before physical work;
 * retain its exact formatted reply before acknowledgement. A replay of a
 * completed call reads that receipt without polling or refreshing credentials.
 * The root session binds one physical action. Compound tools receive a factory
 * for explicitly named steps under the same original accepted call. */
export async function executeSandboxV2AcceptedToolAction(
  db: Database,
  authority: SandboxJournalTurnAuthority,
  options: Omit<ConstructorParameters<typeof MachineSandboxSession>[0], "persistence">,
  callItem: Record<string, unknown>,
  invoke: (
    session: MachineSandboxSession,
    operation: (key: string) => MachineSandboxSession,
  ) => Promise<string>,
  outputPolicy: { modelToolOutputTruncationTokens?: number } = {},
): Promise<string> {
  const context = structuredClone(authority);
  const call = structuredClone(callItem);
  options = {
    ...options,
    instance: structuredClone(options.instance),
    capabilities: { ...options.capabilities },
    ...(options.journal ? { journal: { ...options.journal } } : {}),
  };
  if (
    options.machineId !== context.machineId ||
    !isDeepStrictEqual(options.instance, context.instance) ||
    call.type !== "function_call" ||
    call.callId !== context.acceptedActionId ||
    typeof call.name !== "string"
  )
    throw new JournalBindingError("Accepted sandbox tool call binding changed");
  const receipt = {
    ...context,
    callId: context.acceptedActionId,
    callType: "function_call",
    callItem: call,
    ...(outputPolicy.modelToolOutputTruncationTokens !== undefined
      ? {
          modelToolOutputTruncationTokens: outputPolicy.modelToolOutputTruncationTokens,
        }
      : {}),
  };
  const admitted = await registerPendingSessionToolCall(db, receipt);
  if (!admitted.accepted) throw new JournalBindingError("Accepted sandbox tool authority rejected");
  const prior = await loadSandboxJournalToolReply(db, context);
  if (prior !== null) return prior;
  const session = new MachineSandboxSession({
    ...options,
    persistence: createSandboxV2CommandPersistence(db, context),
  });
  const steps = new Map<string, MachineSandboxSession>();
  const operation = (key: string) => {
    if (!key) throw new JournalBindingError("Compound sandbox operation requires a stable key");
    let step = steps.get(key);
    if (!step) {
      step = new MachineSandboxSession({
        ...options,
        persistence: createSandboxV2CommandPersistence(db, context, key),
      });
      steps.set(key, step);
    }
    return step;
  };
  const output = await invoke(session, operation);
  const retained = await recordPendingSessionToolCallResult(db, {
    ...receipt,
    resultItem: {
      type: "function_call_result",
      callId: context.acceptedActionId,
      name: call.name,
      output,
    },
    eventOutput: output,
  });
  if (!retained.accepted)
    throw new JournalBindingError("Accepted sandbox result authority rejected");
  const reply = await loadSandboxJournalToolReply(db, context);
  if (reply === null)
    throw new JournalBindingError("Sandbox tool reply was not retained before acknowledgement");
  return reply;
}

/** Separate control-only composition. A cancellation rechecks durable
 * revocation before every provider call. Unknown/lost/timeout observations
 * retain demand; only an exact native terminal receipt can release it. Output
 * cursors and agent events are never changed by this path. */
export function createSandboxV2CommandReconciler(
  db: Database,
  authority: SandboxJournalControlAuthority,
  transport: MachineExecTransport,
  options?: ConstructorParameters<typeof MachineJournalClient>[3],
) {
  const context = structuredClone(authority);
  const journal = new MachineJournalClient(
    { machineId: context.machineId, instance: context.instance },
    transport,
    {
      reserve: async () => {
        throw new JournalBindingError("Control reconciliation cannot launch commands");
      },
      assert: async (command, action) => {
        if (action !== "read" && action !== "cancel")
          throw new JournalBindingError("Control reconciliation cannot execute or input");
        await assertSandboxJournalControl(db, context, command, action);
      },
    },
    options,
  );
  async function retainTerminal(
    command: JournalCommand,
    observation: Awaited<ReturnType<typeof journal.read>>,
  ) {
    if (observation.state === "exited" || observation.state === "cancelled")
      await settleSandboxJournalControl(db, context, command, observation);
    return observation;
  }
  return {
    abandonUnbound: (operationId: string) =>
      abandonUnboundSandboxJournalControl(db, context, operationId),
    inspect: async (command: JournalCommand, signal?: AbortSignal) =>
      retainTerminal(
        command,
        await journal.read(command, { stdout: 0, stderr: 0, bytes: 1 }, signal),
      ),
    cancel: async (command: JournalCommand, signal?: AbortSignal) =>
      retainTerminal(command, await journal.cancel(command, signal)),
  };
}
