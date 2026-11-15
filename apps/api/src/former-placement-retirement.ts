import { resolveFirstPartyDelegationSecret } from "@opengeni/config";
import type { AccessGrant } from "@opengeni/contracts";
import {
  getSession,
  listLostConnectedInteractionControllers,
  listSourceFormerPlacementResources,
  releaseLostConnectedInteractionController,
  terminalizeStaleConnectedInteractionPlacement,
  type LostConnectedInteractionController,
} from "@opengeni/db";
import {
  BrowserControlRequestError,
  provisionBrowserControlClient,
  type BrowserControlClient,
  type BrowserControlPlacementSession,
} from "@opengeni/runtime/sandbox";
import { deriveBrowserControllerAdminToken } from "./browser-controller-authority";
import { withFormerConnectedMachine, type ChannelAServices } from "./sandbox/channel-a";
import { errorMessage } from "@opengeni/contracts/values";

export type FormerPlacementControllerClient = Pick<
  BrowserControlClient,
  "endSession" | "endComputerSession"
>;

/** Everything retirement needs from the outside, so its rules are testable
 * without a database, a bus or a machine. */
export type FormerPlacementRetirementPorts = {
  /** Lost resources on the former machine that still hold a controller. */
  listControllers: () => Promise<LostConnectedInteractionController[]>;
  /** Run `fn` against the former machine, or report that it is unreachable. */
  withMachine: <T>(
    fn: (session: BrowserControlPlacementSession) => Promise<T>,
  ) => Promise<{ reached: true; value: T } | { reached: false }>;
  /** One controller client for one controller scope generation. */
  provisionClient: (
    session: BrowserControlPlacementSession,
    placementInstanceId: string,
  ) => Promise<FormerPlacementControllerClient>;
  release: (controller: LostConnectedInteractionController) => Promise<boolean>;
  onFailure: (controller: LostConnectedInteractionController | null, error: unknown) => void;
};

export type FormerPlacementRetirementResult = {
  /** Controllers ended on the former machine and released in the record. */
  retired: string[];
  /** Controllers still bound because their end did not complete. */
  remaining: string[];
  /** The former machine could not be reached; nothing was attempted. */
  unreachable: boolean;
};

/**
 * End the processes of browsers and Desktops that their source task's move
 * left `lost` on a Connected Machine. Without this they keep running there
 * indefinitely: the task no longer routes to that machine, so no later
 * request ever ends them. Each exact controller generation is ended while
 * keeping its on-disk state (`removeState: false`), so nothing the person
 * could still want is deleted; only then is the record's binding released.
 * A controller that already lost the generation (404) has nothing to end.
 * Failures are reported and leave the binding in place for the next attempt.
 */
export async function retireFormerPlacementControllersWith(
  ports: FormerPlacementRetirementPorts,
): Promise<FormerPlacementRetirementResult> {
  const controllers = await ports.listControllers();
  if (controllers.length === 0) return { retired: [], remaining: [], unreachable: false };
  const retired: string[] = [];
  const reached = await ports.withMachine(async (session) => {
    const clients = new Map<string, Promise<FormerPlacementControllerClient>>();
    for (const controller of controllers) {
      try {
        let client = clients.get(controller.placementInstanceId);
        if (!client) {
          client = ports.provisionClient(session, controller.placementInstanceId);
          clients.set(controller.placementInstanceId, client);
        }
        await endController(await client, controller);
        if (await ports.release(controller)) retired.push(controller.resourceId);
      } catch (error) {
        ports.onFailure(controller, error);
      }
    }
  });
  const retiredIds = new Set(retired);
  return {
    retired,
    remaining: controllers
      .map((controller) => controller.resourceId)
      .filter((resourceId) => !retiredIds.has(resourceId)),
    unreachable: !reached.reached,
  };
}

async function endController(
  client: FormerPlacementControllerClient,
  controller: LostConnectedInteractionController,
): Promise<void> {
  try {
    if (controller.resource === "browser_session") {
      // Discarding the exact generation also stops a browser its controller
      // no longer holds in memory (an agent restart leaves it running
      // detached), while removeState=false keeps its profile and downloads.
      await client.endSession(
        {
          browserSessionId: controller.resourceId,
          controllerGeneration: controller.controllerGeneration,
        },
        { removeState: false, discardWorkingRuntime: true },
      );
    } else {
      await client.endComputerSession(
        {
          computerSessionId: controller.resourceId,
          controllerGeneration: controller.controllerGeneration,
        },
        { removeState: false },
      );
    }
  } catch (error) {
    // The controller no longer holds this generation: nothing runs to end.
    if (error instanceof BrowserControlRequestError && error.status === 404) return;
    throw error;
  }
}

/** Retire the lost controllers a source task's move left on one former
 * Connected Machine. Best effort: it never throws, so callers can run it on
 * their way to reporting the move itself. */
export async function retireFormerPlacementControllers(
  services: ChannelAServices,
  input: {
    grant: AccessGrant;
    sourceSessionId: string;
    connectedSandboxId: string;
    browserSessionIds: readonly string[];
    computerSessionIds: readonly string[];
    origin: string | null;
    waitSignal?: AbortSignal | undefined;
  },
): Promise<FormerPlacementRetirementResult> {
  const { grant, connectedSandboxId } = input;
  const workspaceId = grant.workspaceId;
  const placement = { kind: "connected_machine" as const, sandboxId: connectedSandboxId };
  const onFailure = (controller: LostConnectedInteractionController | null, error: unknown) => {
    console.warn("interaction.former_placement_retirement_failed", {
      workspaceId,
      connectedSandboxId,
      resource: controller?.resource ?? null,
      resourceId: controller?.resourceId ?? null,
      error: errorMessage(error),
    });
  };
  try {
    const sourceSession = await getSession(services.db, workspaceId, input.sourceSessionId);
    if (!sourceSession) throw new Error("source session not found");
    return await retireFormerPlacementControllersWith({
      listControllers: async () =>
        await listLostConnectedInteractionControllers(services.db, {
          accountId: grant.accountId,
          workspaceId,
          connectedSandboxId,
          browserSessionIds: input.browserSessionIds,
          computerSessionIds: input.computerSessionIds,
        }),
      withMachine: async (fn) => {
        // Browser and Desktop controllers share one controller scope, so one
        // end-only route serves both.
        return await withFormerConnectedMachine(
          services,
          {
            accountId: grant.accountId,
            workspaceId,
            session: sourceSession,
            subjectId: grant.subjectId,
            grant,
            waitSignal: input.waitSignal,
            operation: "browser.end",
          },
          connectedSandboxId,
          async (session) => await fn(session as unknown as BrowserControlPlacementSession),
        );
      },
      provisionClient: async (session, placementInstanceId) => {
        const rootSecret = resolveFirstPartyDelegationSecret(services.settings);
        if (!rootSecret) throw new Error("interaction controller authority is not configured");
        const adminToken = deriveBrowserControllerAdminToken({
          rootSecret,
          accountId: grant.accountId,
          workspaceId,
          placement,
          placementInstanceId,
        });
        return (
          await provisionBrowserControlClient(session, {
            adminToken,
            nativeAuthority: {
              scopeId: `${workspaceId}:connected_machine:${connectedSandboxId}`,
              scopeGeneration: placementInstanceId,
            },
            ...(input.origin ? { allowedOrigins: [input.origin] } : {}),
          })
        ).client;
      },
      release: async (controller) =>
        await releaseLostConnectedInteractionController(services.db, {
          accountId: grant.accountId,
          workspaceId,
          resource: controller.resource,
          resourceId: controller.resourceId,
          expectedControllerGeneration: controller.controllerGeneration,
        }),
      onFailure,
    });
  } catch (error) {
    onFailure(null, error);
    return {
      retired: [],
      remaining: [...input.browserSessionIds, ...input.computerSessionIds],
      unreachable: false,
    };
  }
}

/**
 * A browser or Desktop can still be live on a Connected Machine its source
 * task has since moved away from, when nothing used it after the move. Record
 * that move first, as any other use of it would, so ending it can retire its
 * controller there in the same request rather than failing on the move. True
 * when the task has moved away from that machine.
 */
export async function recordSourcePlacementMove(
  services: Pick<ChannelAServices, "db">,
  input: { grant: AccessGrant; sourceSessionId: string; connectedSandboxId: string },
): Promise<boolean> {
  const source = await getSession(services.db, input.grant.workspaceId, input.sourceSessionId);
  if (!source || source.activeSandboxId === input.connectedSandboxId) return false;
  const reconciliation = await terminalizeStaleConnectedInteractionPlacement(services.db, {
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    sourceSessionId: input.sourceSessionId,
    connectedSandboxId: input.connectedSandboxId,
  });
  return reconciliation.sourcePlacementChanged;
}

/**
 * End everything a task's move left `lost` but still running on Connected
 * Machines it no longer runs on: each machine's resources whose controller
 * binding was never released, including earlier attempts that found the
 * machine offline or refusing. Callers first terminalize the machine they
 * noticed the move on, so its live resources are part of the set. Best
 * effort: it never throws.
 */
export async function retireSourceFormerPlacements(
  services: ChannelAServices,
  input: {
    grant: AccessGrant;
    sourceSessionId: string;
    origin: string | null;
    waitSignal?: AbortSignal | undefined;
  },
): Promise<FormerPlacementRetirementResult[]> {
  const { grant, sourceSessionId } = input;
  const results: FormerPlacementRetirementResult[] = [];
  try {
    const machines = await listSourceFormerPlacementResources(services.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceSessionId,
    });
    for (const machine of machines) {
      results.push(
        await retireFormerPlacementControllers(services, {
          grant,
          sourceSessionId,
          connectedSandboxId: machine.connectedSandboxId,
          browserSessionIds: machine.browserSessionIds,
          computerSessionIds: machine.computerSessionIds,
          origin: input.origin,
          waitSignal: input.waitSignal,
        }),
      );
    }
  } catch (error) {
    console.warn("interaction.former_placement_retirement_failed", {
      workspaceId: grant.workspaceId,
      sourceSessionId,
      error: errorMessage(error),
    });
  }
  return results;
}
