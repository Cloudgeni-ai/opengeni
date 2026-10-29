import type { ComposerDraft } from "@opengeni/contracts";
import { getSession, type Database } from "@opengeni/db";

/**
 * A composer draft whose model policy the person did not pick follows the
 * chat. Its stored policy is a stale copy, so it shows the chat's current
 * policy: the same projection the session read returns and that a follow-up
 * message without its own policy runs on. A switch made elsewhere (for
 * example by the agent) therefore shows up in every composer. A picked
 * policy is returned unchanged and costs no read.
 */
export async function composerDraftFollowingChat(
  db: Database,
  workspaceId: string,
  sessionId: string,
  draft: ComposerDraft,
): Promise<ComposerDraft> {
  if (draft.modelProvided !== false) return draft;
  const session = await getSession(db, workspaceId, sessionId);
  if (!session) return draft;
  return {
    ...draft,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    latencyMode: session.latencyMode,
  };
}
