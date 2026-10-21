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
    "The requested Connected Machine is not the machine this session is working on, and computer and browser sessions open on that machine. " +
    `To use it, call sandbox_swap with target "${targetSandboxId}" if it is available, then retry; staying on that machine afterwards is fine.`
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
