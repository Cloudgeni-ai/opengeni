/** The one refusal a card can resolve: the owner just has not allowed this chat. */
export const MACHINE_PERMISSION_REQUIRED_CODE = "personal_machine_permission_required";

/**
 * What the agent reads after the card was posted for it. The card is posted in
 * this chat's Opengeni timeline; the person may instead be reading the chat in
 * Slack, or this may be a worker or scheduled chat, so the text names the chat
 * link rather than promising the card is in front of them. Choosing the
 * machine on the card sends a message that continues the chat, so the agent
 * has nothing to wait for and nothing to retry.
 */
export function machinePermissionCardShownReason(chatUrl: string | null): string {
  const elsewhere = chatUrl
    ? `If they are reading this chat somewhere else (for example Slack, or this is a worker or scheduled chat), give them this link to allow it: ${chatUrl}. `
    : "If they are reading this chat somewhere else (for example Slack, or this is a worker or scheduled chat), tell them to open this chat in Opengeni to allow it. ";
  return (
    "This is a personal (Only me) machine, and its owner has not allowed this chat to use it yet. " +
    "A card where the owner can allow it is now posted in this chat in Opengeni. " +
    "If they are reading this chat in Opengeni, tell them in one short sentence that they can allow it there; do not describe buttons or steps. " +
    elsewhere +
    "Do not wait for it and do not retry: when they allow it, their message continues this chat."
  );
}

type MachineRefusal = { code?: string | undefined; reason?: string | undefined };

export type MachinePermissionCardPost = () => Promise<{
  eventId: string | null;
  chatUrl: string | null;
} | null>;

/**
 * Post the Connected Machine card when a swap or one-off command was refused
 * only because the machine's owner has not allowed this chat yet, and tell the
 * agent it is posted. Every other result is returned unchanged. Posting is best
 * effort: if it cannot be posted, the original refusal still stands.
 */
export async function withMachinePermissionCard<T extends MachineRefusal>(
  result: T,
  post: MachinePermissionCardPost,
): Promise<T & { card?: "shown"; cardEventId?: string | null; chatUrl?: string }> {
  if (result.code !== MACHINE_PERMISSION_REQUIRED_CODE) return result;
  let posted: Awaited<ReturnType<MachinePermissionCardPost>>;
  try {
    posted = await post();
  } catch {
    return result;
  }
  if (!posted) return result;
  return {
    ...result,
    reason: machinePermissionCardShownReason(posted.chatUrl),
    card: "shown",
    cardEventId: posted.eventId,
    ...(posted.chatUrl ? { chatUrl: posted.chatUrl } : {}),
  };
}

/** The Opengeni console link for a chat, or null when no safe web base is configured. */
export function sessionChatUrl(
  base: string | null | undefined,
  workspaceId: string,
  sessionId: string,
): string | null {
  if (!base) return null;
  try {
    const url = new URL(
      `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
      base,
    );
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
