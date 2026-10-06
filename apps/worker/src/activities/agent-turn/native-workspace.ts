import type { AttemptToolExecutionContext } from "@opengeni/codemode";
import { SANDBOX_V2_MAX_CAPTURE_RESPONSE_BYTES } from "@opengeni/contracts";
import { executeSandboxV2WorkspaceStep } from "@opengeni/core";
import { retainSandboxV2PreparationPlan, type Database } from "@opengeni/db";
import { JournalBindingError, SandboxChannelAService } from "@opengeni/runtime/sandbox";
import type { SandboxRuntimeState } from "./turn-context";

/** Ordinary gateway authority precedes this adapter. The same native owner
 * tracks each explicitly named physical step; filesystem helpers retain their
 * existing confinement, framing, batch validation and change notifications.
 * This adapter owns no legacy lease, provider session, archive or admission. */
export function createNativeTurnWorkspaceChannel(
  db: Database,
  owner: NonNullable<SandboxRuntimeState["nativeTurn"]>,
  input: AttemptToolExecutionContext,
  options: Pick<ConstructorParameters<typeof SandboxChannelAService>[0], "emit" | "runAs"> & {
    sourceSnapshotDigest?: string;
  } = {},
): SandboxChannelAService {
  const { sourceSnapshotDigest, ...channelOptions } = options;
  const context = { ...input, caller: structuredClone(input.caller) };
  const machine = {
    ...owner.machine,
    authority: structuredClone(owner.machine.authority),
    capabilities: { ...owner.machine.capabilities },
  };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(context.operationId) ||
    !/^[a-f0-9]{64}$/u.test(context.requestDigest ?? "") ||
    (sourceSnapshotDigest !== undefined && !/^[a-f0-9]{64}$/u.test(sourceSnapshotDigest)) ||
    !["model", "codemode"].includes(context.caller.kind) ||
    (context.caller.kind === "model" && !context.sourceCallId)
  )
    throw new JournalBindingError("Native workspace requires its accepted gateway operation");
  owner.invocations.assertOpen();
  context.signal?.throwIfAborted();
  return new SandboxChannelAService({
    ...channelOptions,
    session: {},
    workspaceRoot: owner.binding.session.state.manifest.root,
    commandExecution: {
      scopeId: context.operationId,
      execute: async (stepId, command, stdin) =>
        await owner.invocations.run(async (signal) => {
          const combined = context.signal ? AbortSignal.any([signal, context.signal]) : signal;
          combined.throwIfAborted();
          await owner.binding.authorizeResources?.();
          combined.throwIfAborted();
          await retainSandboxV2PreparationPlan(db, machine.authority, {
            setupId: `workspace-operation:v1:${context.operationId}`,
            workspaceRoot: owner.binding.session.state.manifest.root,
            workspaceOperation: {
              operationId: context.operationId,
              requestDigest: context.requestDigest!,
              ...(sourceSnapshotDigest === undefined ? {} : { sourceSnapshotDigest }),
            },
            steps: [],
            files: [],
          });
          combined.throwIfAborted();
          return await executeSandboxV2WorkspaceStep(
            db,
            machine,
            { operationId: context.operationId, stepId, command },
            {
              environment: async () => ({}),
              workspaceRoot: owner.binding.session.state.manifest.root,
              signal: combined,
              ...(/^fs-read(?:-confined)?:/u.test(stepId)
                ? { outputWindowBytes: SANDBOX_V2_MAX_CAPTURE_RESPONSE_BYTES }
                : {}),
              authorizeWrite: async () => {
                owner.invocations.assertOpen();
                combined.throwIfAborted();
                await owner.binding.authorizeResources?.();
                combined.throwIfAborted();
              },
              ...(stdin === undefined ? {} : { stdin: async () => stdin }),
            },
          );
        }),
    },
  });
}
