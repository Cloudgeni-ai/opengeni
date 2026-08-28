import type { ChannelASession } from "@opengeni/runtime/sandbox";
import type { SandboxRuntimeState } from "./turn-context";

type ImageReferenceSandboxState = Pick<
  SandboxRuntimeState,
  "resolvedSandbox" | "lazyOwnedSandbox" | "turnSandboxProvisioner"
>;

/**
 * Join the turn's canonical lazy sandbox boundary before reading a
 * model-supplied /workspace image reference. Durable File and artifact
 * references never call this helper because their bytes come from object
 * storage instead.
 */
export async function resolveImageReferenceSandboxSession(
  sandboxState: ImageReferenceSandboxState,
  sdkOwnedSandboxSession: unknown,
): Promise<{ session: ChannelASession; leaseEpoch: number }> {
  let sandbox = sandboxState.resolvedSandbox;
  if (!sandbox && sandboxState.turnSandboxProvisioner) {
    sandbox = await sandboxState.turnSandboxProvisioner.get();
  }

  const session = (sandboxState.lazyOwnedSandbox?.session ??
    sandbox?.established.session ??
    sdkOwnedSandboxSession) as ChannelASession | null;
  if (!session) {
    throw new Error("Sandbox image reference is unavailable");
  }

  return {
    session,
    leaseEpoch: sandbox?.leaseEpoch ?? 0,
  };
}
