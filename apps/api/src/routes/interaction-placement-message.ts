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
