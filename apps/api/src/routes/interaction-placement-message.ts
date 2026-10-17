import { SelfhostedControlError } from "@opengeni/runtime/sandbox";
import { HTTPException } from "hono/http-exception";

/**
 * The 422 a session gets when it asks for a computer or browser on a Connected
 * Machine it is not currently placed on. Name the exact way to get there so an
 * agent switches itself over instead of delegating or giving up, and keep it
 * conditional because not every session is allowed to swap.
 */
export function wrongInteractionPlacementMessage(targetSandboxId: string): string {
  return (
    "The requested Connected Machine is not this session's current placement. " +
    `Move the session to that machine before creating an interaction resource: if sandbox_swap is available, call it with target "${targetSandboxId}", retry, and swap back (target "session") when done.`
  );
}

/**
 * Creating a computer or browser on a Connected Machine first reaches the
 * session's current machine. When that machine is offline the request fails
 * as offline even though the requested machine may be online and the real
 * problem is that the session is placed elsewhere. Report that instead, so
 * the agent moves to the requested machine rather than giving up on it.
 * Checked only after an offline failure, so successful requests pay nothing.
 */
export async function wrongPlacementInsteadOfOffline(
  error: unknown,
  requestedSandboxId: string,
  currentSandboxId: () => Promise<string | null>,
): Promise<unknown> {
  const controlError =
    error instanceof SelfhostedControlError
      ? error
      : error instanceof HTTPException && error.cause instanceof SelfhostedControlError
        ? error.cause
        : null;
  if (!controlError?.agentOffline) return error;
  const current = await currentSandboxId().catch(() => undefined);
  if (current === undefined || current === requestedSandboxId) return error;
  return new HTTPException(422, { message: wrongInteractionPlacementMessage(requestedSandboxId) });
}
