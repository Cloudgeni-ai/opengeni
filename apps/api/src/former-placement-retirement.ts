import { resolveFirstPartyDelegationSecret } from "@opengeni/config";
import type { AccessGrant } from "@opengeni/contracts";
import {
  getSession,
  listLostConnectedInteractionControllers,
  releaseLostConnectedInteractionController,
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
      await client.endSession(
        {
          browserSessionId: controller.resourceId,
          controllerGeneration: controller.controllerGeneration,
        },
        { removeState: false },
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
      error: error instanceof Error ? error.message : String(error),
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
