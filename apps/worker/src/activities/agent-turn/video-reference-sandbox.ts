import type { GenerateVideoToolInput } from "@opengeni/contracts";
import { videoReferencePaths } from "../video-reference-staging";
import type { SandboxRuntimeState } from "./turn-context";
import { resolveTurnSandboxAccess, type ResolvedTurnSandboxAccess } from "./turn-sandbox-access";

type VideoReferenceSandboxState = Pick<
  SandboxRuntimeState,
  "resolvedSandbox" | "lazyOwnedSandbox" | "turnSandboxProvisioner"
>;

/** Text-to-video stays sandbox-free; source-bearing requests join the turn sandbox before I/O. */
export async function resolveVideoReferenceSandboxAccess(
  request: GenerateVideoToolInput,
  sandboxState: VideoReferenceSandboxState,
  sdkOwnedSandboxSession: unknown,
): Promise<ResolvedTurnSandboxAccess | null> {
  if (videoReferencePaths(request).length === 0) return null;
  return await resolveTurnSandboxAccess(
    sandboxState,
    sdkOwnedSandboxSession,
    "Video reference sandbox is unavailable",
  );
}
