import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireSandboxMachineForAttempt,
  readSandboxSessionEngineRoute,
  releaseRevokedSandboxMachineAttempt,
  type Database,
  type SandboxJournalTurnAuthority,
  type SandboxMachineAttemptAuthority,
  type SandboxSessionEngineRoute,
} from "@opengeni/db";
import {
  JournalBindingError,
  MachineController,
  MachineJournalClient,
  type MachineBackend,
  type MachineExecTransport,
} from "@opengeni/runtime/sandbox";
import { createSandboxV2MachineStore } from "./sandbox-v2-store";

export class SandboxV2MachineUnavailableError extends Error {
  readonly code = "SANDBOX_V2_MACHINE_UNAVAILABLE";
  constructor(readonly route: SandboxSessionEngineRoute) {
    super("Workspace compute is unavailable");
  }
}

export type SandboxV2TurnMachine = {
  engine: "machine-v2";
  authority: Omit<SandboxJournalTurnAuthority, "acceptedActionId">;
  provider: string;
  transport: MachineExecTransport;
  capabilities: { stdin: boolean; pty: boolean };
  /** Removes only this attempt's demand after durable revocation. Commands keep
   * their separate demand until physical terminal evidence is committed. */
  releaseRevoked(): Promise<boolean>;
};

/** Establish one retained machine for the exact attempt. This performs neither
 * legacy lease acquisition nor archive restoration. Provider installation is
 * separate from fresh-admission qualification; existing groups keep their route
 * when admission flags change. Startup timeout/cancellation retains demand and
 * any ambiguous transition for control recovery, never creates a replacement. */
export async function establishSandboxV2MachineForAttempt(
  db: Database,
  input: Omit<SandboxMachineAttemptAuthority, "machineId">,
  providers: ReadonlyMap<string, { backend: MachineBackend; transport: MachineExecTransport }>,
  options: { idleGraceMs: number; waitMs?: number; signal?: AbortSignal },
): Promise<{ engine: "legacy" } | SandboxV2TurnMachine> {
  const context = structuredClone(input);
  options = { ...options };
  const waitMs = options.waitMs ?? 60_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 300_000)
    throw new JournalBindingError("Invalid machine establishment wait");
  options.signal?.throwIfAborted();
  const route = await readSandboxSessionEngineRoute(db, context);
  if (route.engine === "legacy") return { engine: "legacy" };
  const installation = providers.get(route.provider);
  if (!installation || installation.backend.provider !== route.provider)
    throw new SandboxV2MachineUnavailableError(route);
  const { backend, transport: nativeTransport } = installation;
  const authority = { ...context, machineId: route.machineId };
  const signal = AbortSignal.any([
    AbortSignal.timeout(waitMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const scope = { workspaceId: context.workspaceId, sandboxGroupId: route.sandboxGroupId };
  const controller = new MachineController(
    createSandboxV2MachineStore(db, context.accountId),
    backend,
    options.idleGraceMs,
  );
  await acquireSandboxMachineForAttempt(db, authority);
  for (;;) {
    signal.throwIfAborted();
    // Recheck the canonical attempt before every lifecycle pass. A stale worker
    // cannot turn discovery into fresh wake ownership after revocation.
    await acquireSandboxMachineForAttempt(db, authority);
    const machine = await controller.step(scope, { signal });
    if (machine.state === "running" && machine.instance && machine.transition === null) {
      const instance = structuredClone(machine.instance);
      // Physical I/O remains bounded independently of a long model turn. Every
      // journal call rechecks the attempt and exact retained incarnation before
      // reaching the installed provider. No provider exec retries live here.
      const transport: MachineExecTransport = {
        exec: async (request) => {
          request = {
            ...request,
            argv: [...request.argv],
            ...(request.stdin ? { stdin: request.stdin.slice() } : {}),
          };
          request.signal?.throwIfAborted();
          if (request.instanceId !== instance.id)
            throw new JournalBindingError("Machine transport incarnation changed");
          const current = await acquireSandboxMachineForAttempt(db, authority);
          if (
            current.state !== "running" ||
            current.transition !== null ||
            !isDeepStrictEqual(current.instance, instance)
          )
            throw new JournalBindingError("Retained machine incarnation is unavailable");
          const rpcSignal = AbortSignal.any([
            AbortSignal.timeout(15_000),
            ...(request.signal ? [request.signal] : []),
          ]);
          rpcSignal.throwIfAborted();
          return nativeTransport.exec({ ...request, signal: rpcSignal });
        },
      };
      const journal = new MachineJournalClient(
        { machineId: machine.id, instance },
        transport,
        {
          reserve: async () => {
            throw new JournalBindingError("Readiness cannot launch commands");
          },
          assert: async () => {
            throw new JournalBindingError("Readiness cannot control commands");
          },
        },
        { attempts: 1 },
      );
      const capabilities = await journal.capabilities(signal);
      signal.throwIfAborted();
      const current = await acquireSandboxMachineForAttempt(db, authority);
      if (
        current.state !== "running" ||
        current.transition !== null ||
        !isDeepStrictEqual(current.instance, instance)
      )
        throw new JournalBindingError("Machine changed during establishment");
      return {
        engine: "machine-v2",
        authority: { ...authority, instance },
        provider: route.provider,
        transport,
        capabilities: { stdin: capabilities.stdin, pty: capabilities.pty },
        releaseRevoked: () => releaseRevokedSandboxMachineAttempt(db, authority),
      };
    }
    await delay(100, undefined, { signal });
  }
}
