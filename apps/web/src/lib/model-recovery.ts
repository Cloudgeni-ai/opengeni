import { currentProviderRecovery, type ProviderRecoveryFacts } from "@opengeni/react";
import type { Session, SessionEvent } from "@/types";

export type ModelRecovery = ProviderRecoveryFacts;

/**
 * Current automatic same-turn provider recovery, never retry authority or a
 * prediction of availability. The shared `@opengeni/react` projection keeps the
 * web app and embedded conversations on one presentation.
 */
export function currentModelRecovery(
  session: Pick<Session, "id" | "status" | "activeTurnId" | "effectiveControl">,
  events: readonly SessionEvent[],
): ModelRecovery | null {
  return currentProviderRecovery(session, events);
}
