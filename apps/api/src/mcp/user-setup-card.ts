import {
  type UserSetupBlocker,
  userSetupBlocker,
  userSetupCardShownMessage,
} from "@opengeni/contracts";

export { sessionChatUrl } from "@opengeni/contracts";

type ToolRefusal = { code?: string | undefined; reason?: string | undefined };

export type UserSetupCardPost = (blocker: UserSetupBlocker) => Promise<{
  eventId: string | null;
  chatUrl: string | null;
} | null>;

/**
 * Post the setup card when a tool was refused for something the person can fix
 * themselves (USER_SETUP_BLOCKERS), and tell the agent it is posted. Every
 * other result is returned unchanged. Posting is best effort: if it cannot be
 * posted, the original refusal still stands.
 */
export async function withUserSetupCard<T extends ToolRefusal>(
  result: T,
  post: UserSetupCardPost,
): Promise<T & { card?: "shown"; cardEventId?: string | null; chatUrl?: string }> {
  const blocker = userSetupBlocker(result.code);
  if (!blocker) return result;
  let posted: Awaited<ReturnType<UserSetupCardPost>>;
  try {
    posted = await post(blocker);
  } catch {
    return result;
  }
  if (!posted) return result;
  return {
    ...result,
    reason: userSetupCardShownMessage(blocker, posted.chatUrl),
    card: "shown",
    cardEventId: posted.eventId,
    ...(posted.chatUrl ? { chatUrl: posted.chatUrl } : {}),
  };
}
