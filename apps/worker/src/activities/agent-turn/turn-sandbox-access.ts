import type { ChannelASession } from "@opengeni/runtime/sandbox";
import type { ResumedTurnSandbox } from "../../sandbox-resume";
import type { SandboxRuntimeState } from "./turn-context";

type TurnSandboxAccessState = Pick<
  SandboxRuntimeState,
  "resolvedSandbox" | "lazyOwnedSandbox" | "turnSandboxProvisioner"
>;

export type ResolvedTurnSandboxAccess = Readonly<{
  sandbox: ResumedTurnSandbox | null;
  session: ChannelASession;
  leaseEpoch: number;
}>;

/** The lazy wrapper remains the agent's owner even after provisioning fills
 * resolvedSandbox with the raw provider handle for capture and release. */
export function ownedTurnSandboxForAgent(sandboxState: TurnSandboxAccessState) {
  return sandboxState.lazyOwnedSandbox ?? sandboxState.resolvedSandbox?.established;
}

/** Join the turn's canonical sandbox boundary and return its active routed session. */
export async function resolveTurnSandboxAccess(
  sandboxState: TurnSandboxAccessState,
  sdkOwnedSandboxSession: unknown,
  unavailableMessage: string,
): Promise<ResolvedTurnSandboxAccess> {
  let sandbox = sandboxState.resolvedSandbox;
  if (!sandbox && sandboxState.turnSandboxProvisioner) {
    sandbox = await sandboxState.turnSandboxProvisioner.get();
  }

  const session = (ownedTurnSandboxForAgent(sandboxState)?.session ??
    sandbox?.established.session ??
    sdkOwnedSandboxSession) as ChannelASession | null;
  if (!session) throw new Error(unavailableMessage);

  return {
    sandbox,
    session,
    leaseEpoch: sandbox?.leaseEpoch ?? 0,
  };
}
