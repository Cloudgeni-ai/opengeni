import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { reconcileSandboxV2AttemptWriters, type SandboxV2TurnMachine } from "@opengeni/core";
import type { Database } from "@opengeni/db";
import {
  createTurnInvocationDrain,
  type PreparedMachineSandbox,
  type TurnInvocationDrain,
} from "@opengeni/runtime";
import { JournalBindingError } from "@opengeni/runtime/sandbox";
import type { SandboxV2ControlProviders } from "./sandbox-v2-control";

export class SandboxV2AttemptWritersPendingError extends Error {
  readonly code = "SANDBOX_V2_ATTEMPT_WRITERS_PENDING";
  constructor() {
    super("Workspace command settlement is pending");
  }
}

/** Worker execution ownership after retained native preparation. The SDK's
 * local callbacks, credential timer and host MCP holder drain independently of
 * physical journal evidence. This owner never captures an archive or destroys,
 * rotates, resumes, replaces or adopts a machine/unfinished command. */
export function createSandboxV2TurnExecution(
  db: Database,
  machine: SandboxV2TurnMachine,
  prepared: PreparedMachineSandbox,
  providers: SandboxV2ControlProviders,
  options: {
    signal?: AbortSignal;
    invocations?: TurnInvocationDrain;
    credentialRenewal?: { stop(): Promise<void> };
    runMcpCredentials?: { close(): void };
  } = {},
) {
  machine = {
    ...machine,
    authority: structuredClone(machine.authority),
    capabilities: { ...machine.capabilities },
  };
  options = { ...options };
  const provider = providers.get(machine.provider);
  if (
    !provider ||
    provider.backend.provider !== machine.provider ||
    prepared.session.state.kind !== "machine-v2" ||
    prepared.session.state.machineId !== machine.authority.machineId ||
    !isDeepStrictEqual(prepared.session.state.instance, machine.authority.instance) ||
    prepared.capabilities.length === 0 ||
    (prepared.invocationDrain &&
      options.invocations &&
      prepared.invocationDrain !== options.invocations)
  )
    throw new JournalBindingError(
      "Native execution owner requires its exact prepared machine and provider",
    );
  const controlTransport = provider.transport;
  const invocations =
    prepared.invocationDrain ?? options.invocations ?? createTurnInvocationDrain(options.signal);
  const stopForSignal = () => invocations.cancel(options.signal?.reason);
  if (options.signal?.aborted) stopForSignal();
  else options.signal?.addEventListener("abort", stopForSignal, { once: true });
  const binding: PreparedMachineSandbox = {
    session: prepared.session,
    capabilities: [...prepared.capabilities],
    files: structuredClone(prepared.files ?? []),
    repositories: structuredClone(prepared.repositories ?? []),
    ...(prepared.authorizeResources ? { authorizeResources: prepared.authorizeResources } : {}),
    invocationDrain: invocations,
  };
  let drained: Promise<void> | null = null;
  const closeAndDrain = async (reason?: unknown) => {
    if (!drained) {
      options.signal?.removeEventListener("abort", stopForSignal);
      invocations.cancel(reason);
      let closeError: unknown;
      try {
        options.runMcpCredentials?.close();
      } catch (error) {
        closeError = error;
      }
      drained = (async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => invocations.waitForDrain()),
          Promise.resolve().then(() => options.credentialRenewal?.stop()),
        ]);
        for (const result of results) if (result.status === "rejected") throw result.reason;
        if (closeError !== undefined) throw closeError;
      })();
    }
    await drained;
  };
  return {
    machine,
    binding,
    invocations,
    fileDownloadAudience: provider.fileDownloadAudience ?? null,
    credentialRenewal: options.credentialRenewal ?? null,
    runMcpCredentials: options.runMcpCredentials ?? null,
    /** Local resource teardown may follow this promise even while physical
     * settlement stays unknown. It never licenses a quiescence receipt. */
    closeAndDrain,
    /** Local closure is sticky across control retries. Only an actual drained
     * journal result releases this revoked attempt's demand; unknown or lost
     * command ownership survives and the caller must withhold quiescence. */
    finalize: async (
      input: {
        reason?: unknown;
        limit?: number;
        afterOperationId?: string;
        signal?: AbortSignal;
        /** Bounded observation of the same retained writers. Zero is one
         * control pass; a deadline never substitutes for physical proof. */
        waitMs?: number;
      } = {},
    ) => {
      await closeAndDrain(input.reason);
      const waitMs = input.waitMs ?? 0;
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000)
        throw new JournalBindingError("Invalid native finalization observation budget");
      const deadline = Date.now() + waitMs;
      const budget = waitMs ? AbortSignal.timeout(waitMs) : null;
      const signal = budget
        ? AbortSignal.any([budget, ...(input.signal ? [input.signal] : [])])
        : input.signal;
      let result: Awaited<ReturnType<typeof reconcileSandboxV2AttemptWriters>> = {
        state: "held",
        items: [],
        nextOperationId: null,
      };
      for (;;) {
        input.signal?.throwIfAborted();
        try {
          result = await reconcileSandboxV2AttemptWriters(db, machine.authority, controlTransport, {
            ...input,
            ...(signal ? { signal } : {}),
          });
          if (result.state === "drained") {
            await machine.releaseRevoked();
            return result;
          }
          if (!waitMs || result.state === "live" || Date.now() >= deadline) return result;
          await delay(Math.min(100, deadline - Date.now()), undefined, { signal });
        } catch (error) {
          input.signal?.throwIfAborted();
          if (budget?.aborted) return { ...result, state: "held" as const };
          throw error;
        }
      }
    },
  };
}
export type SandboxV2TurnExecution = ReturnType<typeof createSandboxV2TurnExecution>;
