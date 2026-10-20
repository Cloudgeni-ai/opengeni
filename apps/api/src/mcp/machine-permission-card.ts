import type { SessionEvent } from "@opengeni/contracts";

/** The one refusal a card can resolve: the owner just has not allowed this chat. */
export const MACHINE_PERMISSION_REQUIRED_CODE = "personal_machine_permission_required";

/** The capability whose chat card lists machines with "Use in this chat". */
const CONNECTED_MACHINE_CAPABILITY_ID = "api:connected-machine";

/**
 * What the agent reads after the card was shown for it. The person already
 * sees the card, and choosing the machine there sends a message that continues
 * the chat, so the agent has nothing to wait for and nothing to retry.
 */
export const MACHINE_PERMISSION_CARD_SHOWN_REASON =
  "This is a personal (Only me) machine, and its owner has not allowed this chat to use it yet. " +
  "A card is now shown in this chat where the owner can allow it. " +
  "Tell them in one short sentence that they can allow it there; do not describe buttons or steps. " +
  "Do not wait for it and do not retry: when they allow it, their message continues this chat.";

type MachineRefusal = { code?: string | undefined; reason?: string | undefined };

export type MachinePermissionCardPost = () => Promise<{ eventId: string | null } | null>;

/**
 * Show the Connected Machine card when a swap or one-off command was refused
 * only because the machine's owner has not allowed this chat yet, and tell the
 * agent it is shown. Every other result is returned unchanged. Showing the card
 * is best effort: if it cannot be posted, the original refusal still stands.
 */
export async function withMachinePermissionCard<T extends MachineRefusal>(
  result: T,
  post: MachinePermissionCardPost,
): Promise<T & { card?: "shown"; cardEventId?: string | null }> {
  if (result.code !== MACHINE_PERMISSION_REQUIRED_CODE) return result;
  let posted: { eventId: string | null } | null;
  try {
    posted = await post();
  } catch {
    return result;
  }
  if (!posted) return result;
  return {
    ...result,
    reason: MACHINE_PERMISSION_CARD_SHOWN_REASON,
    card: "shown",
    cardEventId: posted.eventId,
  };
}

/**
 * The Connected Machine card this turn already shows, if any. One machine card
 * lists every machine, so a repeated refusal in the same turn points at it
 * instead of stacking an identical card. Other cards are never affected.
 */
export function connectedMachineCardInTurn(
  events: readonly Pick<SessionEvent, "id" | "type" | "turnId" | "payload" | "turnAssociation">[],
  turnId: string,
): string | null {
  for (const event of events) {
    if (event.type !== "tool.auth_needed" || event.turnId !== turnId) continue;
    if (event.turnAssociation && event.turnAssociation !== "current") continue;
    const payload = event.payload as { capability?: { id?: unknown } } | null;
    if (payload?.capability?.id === CONNECTED_MACHINE_CAPABILITY_ID) return event.id;
  }
  return null;
}
