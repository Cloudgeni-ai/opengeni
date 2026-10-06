import { createHash } from "node:crypto";
import type { Database } from "@opengeni/db";
import {
  JournalBindingError,
  MachineSandboxSession,
  type ChannelAExecArgs,
  type MachineExecResult,
  type MachineExecTransport,
} from "@opengeni/runtime/sandbox";
import { createSandboxV2CommandPersistence } from "./sandbox-v2-command-store";
import type { SandboxV2TurnMachine } from "./sandbox-v2-turn";

export class SandboxV2SetupFailedError extends Error {
  readonly code = "SANDBOX_V2_SETUP_FAILED";
  constructor(
    readonly stepId: string,
    readonly exitCode: number,
  ) {
    super("Workspace setup did not complete successfully");
  }
}

/** Execute one trusted platform setup step, identified by the retained setup
 * plan and explicit step key. These identities must survive activity retries;
 * counters, fresh UUIDs and the current command body cannot identify a step.
 * Setup has its own namespace and does not impersonate an accepted model tool.
 * Cancellation stops observation, preserving the command for control recovery.
 * A transport failure or unknown outcome never starts a replacement command. */
export async function executeSandboxV2SetupStep(
  db: Database,
  machine: SandboxV2TurnMachine,
  input: { setupId: string; stepId: string; command: ChannelAExecArgs },
  options: {
    environment: () => Promise<Record<string, string>>;
    prepareEnvironmentBeforeAllocation?: boolean;
    workspaceRoot?: string;
    signal?: AbortSignal;
    /** Additional owner fence immediately before a physical Start/input. Reads
     * of an already completed step remain available for receipt recovery. */
    authorizeWrite?: () => Promise<void>;
    /** One immutable payload from the retained setup plan. Keep sensitive data
     * off argv/environment; replay must resolve the same original payload. */
    stdin?: () => Promise<string>;
  },
): Promise<MachineExecResult & { exitCode: 0 }> {
  const result = await executeRetainedPlatformStep(
    db,
    machine,
    input,
    options,
    "platform-setup-v1",
  );
  if (result.exitCode !== 0) throw new SandboxV2SetupFailedError(input.stepId, result.exitCode);
  return { ...result, exitCode: 0 };
}

/** One named physical step of an already authorized workspace tool operation.
 * Its gateway identity is causal, never a grant. The original attempt fence
 * still owns Start/input; a nonzero exit is an ordinary filesystem result. */
export async function executeSandboxV2WorkspaceStep(
  db: Database,
  machine: SandboxV2TurnMachine,
  input: { operationId: string; stepId: string; command: ChannelAExecArgs },
  options: Parameters<typeof executeSandboxV2SetupStep>[3] & { outputWindowBytes?: number },
): Promise<MachineExecResult & { exitCode: number }> {
  return await executeRetainedPlatformStep(
    db,
    machine,
    { setupId: input.operationId, stepId: input.stepId, command: input.command },
    options,
    "platform-workspace-v1",
  );
}

async function executeRetainedPlatformStep(
  db: Database,
  machine: SandboxV2TurnMachine,
  input: { setupId: string; stepId: string; command: ChannelAExecArgs },
  options: Parameters<typeof executeSandboxV2SetupStep>[3] & { outputWindowBytes?: number },
  namespace: "platform-setup-v1" | "platform-workspace-v1",
): Promise<MachineExecResult & { exitCode: number }> {
  input = structuredClone(input);
  options = { ...options };
  const authority = structuredClone(machine.authority);
  const provider = machine.provider;
  const capabilities = { ...machine.capabilities };
  const nativeTransport = machine.transport;
  if (
    typeof input.setupId !== "string" ||
    !input.setupId ||
    input.setupId.length > 512 ||
    typeof input.stepId !== "string" ||
    !/^[a-zA-Z0-9_./:-]{1,128}$/u.test(input.stepId)
  )
    throw new JournalBindingError("Invalid retained setup step identity");
  const requestedWait = input.command.yieldTimeMs ?? 1000;
  if (!Number.isSafeInteger(requestedWait) || requestedWait < 0)
    throw new JournalBindingError("Invalid setup observation budget");
  options.signal?.throwIfAborted();
  const acceptedActionId = `${namespace}:${createHash("sha256")
    .update(JSON.stringify([namespace, input.setupId]))
    .digest("hex")}`;
  const transport: MachineExecTransport = {
    exec: (request) => {
      options.signal?.throwIfAborted();
      return nativeTransport.exec({
        ...request,
        ...(options.signal
          ? {
              signal: AbortSignal.any([
                options.signal,
                ...(request.signal ? [request.signal] : []),
              ]),
            }
          : {}),
      });
    },
  };
  const sessionOptions = {
    provider,
    machineId: authority.machineId,
    instance: authority.instance,
    transport,
    environment: async () => {
      options.signal?.throwIfAborted();
      const environment = await options.environment();
      options.signal?.throwIfAborted();
      return environment;
    },
    capabilities,
    ...(options.prepareEnvironmentBeforeAllocation
      ? { prepareEnvironmentBeforeAllocation: true }
      : {}),
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.outputWindowBytes !== undefined
      ? { outputWindowBytes: options.outputWindowBytes }
      : {}),
  };
  const operation = (key: string) => {
    const persistence = createSandboxV2CommandPersistence(
      db,
      { ...authority, acceptedActionId },
      key,
    );
    return new MachineSandboxSession({
      ...sessionOptions,
      persistence: {
        ...persistence,
        assert: async (command, action) => {
          await persistence.assert(command, action);
          if (action === "start" || action === "input") await options.authorizeWrite?.();
        },
      },
    });
  };
  const session = operation(input.stepId);
  if (options.stdin && (!capabilities.stdin || input.command.tty))
    throw new JournalBindingError("Setup payload requires a native stdin pipe");
  let result = await session.exec({ ...input.command, yieldTimeMs: Math.min(requestedWait, 1000) });
  if (options.stdin && result.sessionId !== undefined) {
    options.signal?.throwIfAborted();
    const payload = await options.stdin();
    options.signal?.throwIfAborted();
    const inputKey = createHash("sha256").update(input.stepId).digest("hex");
    await operation(`stdin:${inputKey}`).writeCommandInput({
      sessionId: result.sessionId,
      chars: payload,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await operation(`stdin-close:${inputKey}`).closeStdin(result.sessionId, options.signal);
  }
  while (result.sessionId !== undefined) {
    options.signal?.throwIfAborted();
    result = await session.pollCommand({
      sessionId: result.sessionId,
      yieldTimeMs: 1000,
      ...(input.command.maxOutputTokens !== undefined
        ? { maxOutputTokens: input.command.maxOutputTokens }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(result.exitCode))
    throw new JournalBindingError("Setup completion has no exact exit outcome");
  return { ...result, exitCode: result.exitCode! };
}
