import type { Session } from "@opengeni/sdk";

// Status is projected from live events, while activeTurnId can still come from
// an older detail read. Neither signal alone proves that work has settled.
export function sessionHasVariableSetBlockingWork(
  session: Pick<Session, "status" | "activeTurnId">,
): boolean {
  return (
    session.activeTurnId != null ||
    (session.status !== "idle" && session.status !== "failed" && session.status !== "cancelled")
  );
}
