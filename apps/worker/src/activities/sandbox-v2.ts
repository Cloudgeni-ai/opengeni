import { Context } from "@temporalio/activity";
import {
  findSandboxMachine,
  listSandboxMachineInventory,
  listSandboxV2BackgroundOwnersForControl,
  type SandboxMachineInventoryItem,
} from "@opengeni/db";
import {
  createSandboxV2MachineStore,
  reconcileSandboxV2MachineCommands,
  reconcileSandboxV2BackgroundJobs,
} from "@opengeni/core";
import { MachineController } from "@opengeni/runtime/sandbox";
import type { ControlActivityServices } from "./types";
import type { SandboxV2RecoveryCursor } from "../sandbox-v2-control";
import { publishDurableSessionEvents } from "../session-event-fanout";

function activityLifetime() {
  let context: Context | undefined;
  try {
    context = Context.current();
  } catch {
    /* Direct, finite test harness. */
  }
  const deadline = AbortSignal.timeout(240_000);
  const signal = context ? AbortSignal.any([context.cancellationSignal, deadline]) : deadline;
  const timer = context
    ? setInterval(() => context!.heartbeat({ phase: "machine-v2-recovery" }), 5000)
    : undefined;
  timer?.unref();
  return {
    signal,
    close: () => {
      if (timer) clearInterval(timer);
    },
  };
}

export function createSandboxV2ControlActivities(services: () => Promise<ControlActivityServices>) {
  return {
    /** Advisory identities only, never provider I/O. Missing adapters do not
     * hide retained machines from inventory after an admission flag change. */
    async listSandboxV2Machines(input: { afterMachineId?: string } = {}) {
      return listSandboxMachineInventory((await services()).db, { limit: 100, ...input });
    },
    /** One finite machine pass. The workflow carries pagination, and a later
     * sweep restarts it. Partial failure retains durable demand and transition
     * identity. A failed physical RPC cannot become a fresh launch or mutation. */
    async reconcileSandboxV2Machine(
      target: SandboxMachineInventoryItem & SandboxV2RecoveryCursor,
    ): Promise<{
      status: "reconciled" | "deferred";
      nextDemandId: string | null;
      nextOperationId: string | null;
      nextJobId: string | null;
    }> {
      target = structuredClone(target);
      const life = activityLifetime();
      try {
        const service = await services();
        const machine = await findSandboxMachine(service.db, target);
        if (!machine || machine.id !== target.machineId || machine.provider !== target.provider)
          return { status: "deferred", nextDemandId: null, nextOperationId: null, nextJobId: null };
        const provider = service.sandboxV2ControlProviders?.get(machine.provider);
        if (!provider || provider.backend.provider !== machine.provider)
          return { status: "deferred", nextDemandId: null, nextOperationId: null, nextJobId: null };
        life.signal.throwIfAborted();
        const tenant = {
          accountId: target.accountId,
          workspaceId: target.workspaceId,
          machineId: machine.id,
        };
        const transport = {
          exec: (request: Parameters<typeof provider.transport.exec>[0]) =>
            provider.transport.exec({
              ...request,
              signal: AbortSignal.any([life.signal, AbortSignal.timeout(15_000)]),
            }),
        };
        const recovered = await reconcileSandboxV2MachineCommands(service.db, tenant, transport, {
          limit: 4,
          signal: life.signal,
          journal: { attempts: 1 },
          scanAttempts: target.attemptsComplete !== true,
          scanCommands: target.commandsComplete !== true,
          ...(target.afterDemandId !== undefined ? { afterDemandId: target.afterDemandId } : {}),
          ...(target.afterOperationId !== undefined
            ? { afterOperationId: target.afterOperationId }
            : {}),
        });
        life.signal.throwIfAborted();
        let nextJobId: string | null = null;
        if (target.jobsComplete !== true) {
          if (!provider.authorizeBackgroundJobControl) {
            const pending = await listSandboxV2BackgroundOwnersForControl(service.db, tenant, {
              limit: 1,
              includeUnregistered: true,
              ...(target.afterJobId ? { afterJobId: target.afterJobId } : {}),
            });
            if (pending.items.length)
              return {
                status: "deferred",
                nextDemandId: recovered.nextDemandId,
                nextOperationId: recovered.nextOperationId,
                nextJobId: pending.nextJobId,
              };
          } else {
            const background = await reconcileSandboxV2BackgroundJobs(
              service.db,
              tenant,
              transport,
              {
                limit: 4,
                signal: life.signal,
                authorizeJob: (authority) => provider.authorizeBackgroundJobControl!(authority),
                ...(target.afterJobId ? { afterJobId: target.afterJobId } : {}),
              },
            );
            nextJobId = background.nextJobId;
            await publishDurableSessionEvents(service.bus, target.workspaceId, background.events);
            if (background.items.some((item) => item.state === "deferred"))
              return {
                status: "reconciled",
                nextDemandId: recovered.nextDemandId,
                nextOperationId: recovered.nextOperationId,
                nextJobId,
              };
          }
        }
        life.signal.throwIfAborted();
        // No provider calls run inside a database transaction. The controller
        // rereads state and CAS-admits at most one exact lifecycle mutation.
        await new MachineController(
          createSandboxV2MachineStore(service.db, target.accountId),
          provider.backend,
          service.settings.sandboxIdleGraceMs,
        ).step(
          {
            workspaceId: target.workspaceId,
            sandboxGroupId: target.sandboxGroupId,
          },
          { signal: life.signal },
        );
        return {
          status: "reconciled",
          nextDemandId: recovered.nextDemandId,
          nextOperationId: recovered.nextOperationId,
          nextJobId,
        };
      } finally {
        life.close();
      }
    },
  };
}
